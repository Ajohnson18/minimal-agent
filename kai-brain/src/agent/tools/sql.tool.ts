/**
 * SQL Query Tool
 *
 * Allows the agent to query external user databases (read-only).
 * Supports named databases (resolved from env vars) or raw connection strings.
 * Large results are written to temp CSV files — the agent decides how to share them.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import pg from "pg";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const { Pool } = pg;

const FORBIDDEN_PATTERNS =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|REPLACE|GRANT|REVOKE|EXEC|EXECUTE|CALL|SET|LOCK|UNLOCK)\b/i;

// Safety cap — prevents OOM on massive tables. Large results go to file anyway.
import { getConfig } from "../../lib/config-loader.js";
const SAFETY_MAX_ROWS = getConfig().tools.sql.maxRows;

// Threshold for switching from inline table to file-based CSV
const LARGE_RESULT_ROWS = 50;
const LARGE_RESULT_BYTES = 20_000;

const SqlQuerySchema = Type.Object({
  database: Type.Optional(
    Type.String({
      description:
        'Named database to query (e.g. "somethings"). Resolves to connection details from environment.',
    })
  ),
  connection_string: Type.Optional(
    Type.String({
      description:
        "PostgreSQL connection string. Use database parameter instead when a named database is available.",
    })
  ),
  query: Type.String({
    description: "SQL query to execute (read-only, SELECT only). Add LIMIT yourself if you want fewer rows.",
  }),
});

type SqlQueryArgs = Static<typeof SqlQuerySchema>;

const poolCache = new Map<string, InstanceType<typeof Pool>>();

function resolveNamedDatabase(name: string): pg.PoolConfig | null {
  const upper = name.toUpperCase();

  const urlVar = `${upper}_DB_URL`;
  if (process.env[urlVar]) {
    return { connectionString: process.env[urlVar] };
  }

  const host = process.env[`${upper}_DB_HOST`] || process.env[`${upper}_PGHOST`];
  const port = process.env[`${upper}_DB_PORT`] || process.env[`${upper}_PGPORT`];
  const user = process.env[`${upper}_DB_USER`] || process.env[`${upper}_PGUSER`];
  const password = process.env[`${upper}_DB_PASSWORD`] || process.env[`${upper}_PGPASSWORD`];
  const database = process.env[`${upper}_DB_NAME`] || process.env[`${upper}_PGDATABASE`];

  const sslEnv = process.env[`${upper}_DB_SSL`];
  const ssl = sslEnv === "false" || sslEnv === "0"
    ? false
    : { rejectUnauthorized: false };

  if (host || database) {
    const config = {
      host: host || "localhost",
      port: port ? parseInt(port) : 5432,
      user: user || name,
      password: password,
      database: database || name,
      ssl,
    };
    console.log(`[SQL] Resolved database "${name}": ${config.host}:${config.port}/${config.database} (ssl=${ssl === false ? "off" : "on"})`);
    return config;
  }

  return null;
}

function getPool(config: pg.PoolConfig, cacheKey: string): InstanceType<typeof Pool> {
  let pool = poolCache.get(cacheKey);
  if (!pool) {
    pool = new Pool({
      ...config,
      max: 3,
      idleTimeoutMillis: 60_000,
      connectionTimeoutMillis: 10_000,
    });
    poolCache.set(cacheKey, pool);
  }
  return pool;
}

function toCsvValue(val: unknown): string {
  const str = String(val ?? "");
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function createSqlTool(): ToolDefinition {
  return {
    name: "sql_query",
    label: "SQL Query",
    description: `Query an external PostgreSQL database (read-only).
Only SELECT queries are allowed. INSERT, UPDATE, DELETE, DROP, ALTER etc. are blocked.

Use the database parameter with a named database (e.g. database="somethings") when available.
Add LIMIT to your query if you want fewer rows. Large results are automatically saved to a CSV file — use slack_message with filePath to share with the user.`,
    parameters: SqlQuerySchema,
    execute: async (
      _toolCallId: string,
      args: SqlQueryArgs,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback,
      _ctx?: unknown
    ): Promise<AgentToolResult<unknown>> => {
      if (FORBIDDEN_PATTERNS.test(args.query)) {
        return text(
          "Error: Only SELECT queries are allowed. Write operations (INSERT, UPDATE, DELETE, DROP, etc.) are blocked for safety. Do not retry with a write query."
        );
      }

      let poolConfig: pg.PoolConfig;
      let cacheKey: string;

      if (args.database) {
        const resolved = resolveNamedDatabase(args.database);
        if (!resolved) {
          return text(
            `Error: Database "${args.database}" not configured. Set ${args.database.toUpperCase()}_DB_URL or ${args.database.toUpperCase()}_DB_HOST environment variables.`
          );
        }
        poolConfig = resolved;
        cacheKey = `named:${args.database}`;
      } else if (args.connection_string) {
        poolConfig = { connectionString: args.connection_string };
        cacheKey = `cs:${args.connection_string}`;
      } else {
        return text("Error: Either database or connection_string is required. Do not retry without specifying one.");
      }

      const timeoutMs =
        getConfig().tools.sql.queryTimeoutMs;

      try {
        const pool = getPool(poolConfig, cacheKey);
        const client = await pool.connect();

        try {
          await client.query(`SET statement_timeout = ${timeoutMs}`);

          const query = args.query.trim().replace(/;+\s*$/, "");
          const result = await client.query(query);

          if (!result.rows || result.rows.length === 0) {
            return text(`Query executed successfully. No rows returned.`);
          }

          const columns = result.fields.map((f) => f.name);
          // Apply safety cap
          const rows = result.rows.slice(0, SAFETY_MAX_ROWS);
          const totalRows = result.rows.length;
          const capped = totalRows > SAFETY_MAX_ROWS;

          // Estimate size
          const estimatedSize = rows.reduce(
            (s, r) => s + columns.reduce((cs, c) => cs + String(r[c] ?? "").length, 0),
            0
          );

          const isLarge = rows.length > LARGE_RESULT_ROWS || estimatedSize > LARGE_RESULT_BYTES;

          if (isLarge) {
            // Write to temp CSV file
            const csvHeader = columns.join(",");
            const csvBody = rows
              .map((row) => columns.map((col) => toCsvValue(row[col])).join(","))
              .join("\n");
            const csv = `${csvHeader}\n${csvBody}`;

            const dir = join(process.cwd(), ".sandbox", "sql-results");
            await mkdir(dir, { recursive: true });
            const fileName = `query-${Date.now()}.csv`;
            const filePath = join(dir, fileName);
            await writeFile(filePath, csv, "utf-8");

            const summary = [
              `${totalRows} row(s) returned, ${columns.length} columns.`,
              capped ? `(Safety cap applied: showing first ${SAFETY_MAX_ROWS} rows)` : "",
              `Results saved to: ${filePath}`,
              "",
              `Columns: ${columns.join(", ")}`,
              `File size: ${(csv.length / 1024).toFixed(1)} KB`,
              "",
              "Use slack_message with filePath to share this CSV directly. Do NOT read the file content first.",
            ].filter(Boolean).join("\n");

            return text(summary);
          }

          // Small results: inline formatted table
          const maxColWidth = 50;
          const widths = columns.map((col) =>
            Math.min(
              maxColWidth,
              Math.max(col.length, ...rows.map((r) => String(r[col] ?? "NULL").length))
            )
          );

          const header = columns.map((col, i) => col.padEnd(widths[i])).join(" | ");
          const separator = widths.map((w) => "-".repeat(w)).join("-+-");
          const body = rows
            .map((row) =>
              columns
                .map((col, i) =>
                  String(row[col] ?? "NULL").slice(0, maxColWidth).padEnd(widths[i])
                )
                .join(" | ")
            )
            .join("\n");

          return text(`${header}\n${separator}\n${body}\n\n${rows.length} row(s) returned.`);
        } finally {
          client.release();
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return text(`SQL query error: ${msg}`);
      }
    },
  };
}

function text(t: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: t }], details: {} };
}
