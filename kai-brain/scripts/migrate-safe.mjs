import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";
import { Client } from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const journalPath = path.join(rootDir, "drizzle", "meta", "_journal.json");
const migrationsDir = path.join(rootDir, "drizzle");

const DESTRUCTIVE_SQL_PATTERNS = [
  { label: "DROP TABLE", re: /(^|\n)\s*DROP\s+TABLE\b/i },
  { label: "TRUNCATE", re: /(^|\n)\s*TRUNCATE\b/i },
  { label: "DELETE FROM", re: /(^|\n)\s*DELETE\s+FROM\b/i },
  { label: "ALTER TABLE DROP COLUMN", re: /ALTER\s+TABLE[\s\S]*\bDROP\s+COLUMN\b/i },
];

const HARD_CUT_MARKERS = [
  {
    label: "ava_sessions.session_key",
    query: `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'ava_sessions'
          AND column_name = 'session_key'
      ) AS ok;
    `,
  },
  {
    label: "ava_system_events.kind",
    query: `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'ava_system_events'
          AND column_name = 'kind'
      ) AS ok;
    `,
  },
  {
    label: "ava_system_events.event_key",
    query: `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'ava_system_events'
          AND column_name = 'event_key'
      ) AS ok;
    `,
  },
  {
    label: "ava_subagent_runs table",
    query: `SELECT to_regclass('public.ava_subagent_runs') IS NOT NULL AS ok;`,
  },
];

dotenv.config({ path: path.join(rootDir, ".env") });
dotenv.config({ path: path.join(rootDir, ".env.local"), override: true });

const connectionString =
  process.env.AVA_TEST_DB_URL ?? process.env.DATABASE_URL ?? "";

if (!connectionString) {
  console.error(
    "Database URL is required. Set AVA_TEST_DB_URL or DATABASE_URL before running db:migrate:safe.",
  );
  process.exit(1);
}

if (!fs.existsSync(journalPath)) {
  console.error(`Journal file not found: ${journalPath}`);
  process.exit(1);
}

const rawJournal = fs.readFileSync(journalPath, "utf8");
const journal = JSON.parse(rawJournal);
const journalEntries = Array.isArray(journal?.entries) ? journal.entries : [];

if (journalEntries.length === 0) {
  console.error(
    "No migration entries found in drizzle/meta/_journal.json. Refusing to run migrate:safe.",
  );
  process.exit(1);
}

const run = (cmd, args) => {
  const result = spawnSync(cmd, args, {
    cwd: rootDir,
    stdio: "inherit",
    env: process.env,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

const validateMigrationSqlSafety = (entries) => {
  if (process.env.AVA_ALLOW_DESTRUCTIVE_MIGRATION === "1") {
    return;
  }

  for (const entry of entries) {
    const tag = String(entry?.tag ?? "");
    const sqlPath = path.join(migrationsDir, `${tag}.sql`);
    if (!fs.existsSync(sqlPath)) {
      throw new Error(`Missing migration SQL file: ${sqlPath}`);
    }

    const sql = fs.readFileSync(sqlPath, "utf8");
    for (const pattern of DESTRUCTIVE_SQL_PATTERNS) {
      if (pattern.re.test(sql)) {
        throw new Error(
          `Refusing to run migrate:safe because migration ${tag}.sql contains ${pattern.label}. Set AVA_ALLOW_DESTRUCTIVE_MIGRATION=1 to override intentionally.`,
        );
      }
    }
  }
};

validateMigrationSqlSafety(journalEntries);

const client = new Client({ connectionString });

try {
  await client.connect();

  const tableCountResult = await client.query(`
    SELECT count(*)::int AS count
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name LIKE 'ava\\_%' ESCAPE '\\';
  `);

  const hasAvaTables = Number(tableCountResult.rows[0]?.count ?? 0) > 0;

  const migrationTableResult = await client.query(`
    SELECT to_regclass('drizzle.__drizzle_migrations') AS table_name;
  `);

  const hasMigrationTable = Boolean(migrationTableResult.rows[0]?.table_name);

  let appliedCount = 0;
  if (hasMigrationTable) {
    const appliedResult = await client.query(
      "SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations",
    );
    appliedCount = Number(appliedResult.rows[0]?.count ?? 0);
  }

  const markerChecks = await Promise.all(
    HARD_CUT_MARKERS.map(async (marker) => {
      const result = await client.query(marker.query);
      return {
        label: marker.label,
        ok: result.rows[0]?.ok === true,
      };
    }),
  );
  const missingMarkers = markerChecks
    .filter((check) => !check.ok)
    .map((check) => check.label);

  if (hasAvaTables && appliedCount < journalEntries.length) {
    if (missingMarkers.length > 0) {
      console.warn(
        `Skipping baseline because schema appears behind while migration history is incomplete (${appliedCount}/${journalEntries.length}). Missing markers: ${missingMarkers.join(", ")}. Proceeding with db:migrate to apply pending SQL.`,
      );
    } else {
      console.log(
        `Detected existing AVA schema with complete hard-cut markers and partial migration history (${appliedCount}/${journalEntries.length}). Running baseline before migrate.`,
      );
      run("pnpm", ["db:baseline"]);
    }
  } else {
    console.log(
      `Baseline not required (hasAvaTables=${hasAvaTables}, applied=${appliedCount}, journal=${journalEntries.length}, missingMarkers=${missingMarkers.length}).`,
    );
  }
} finally {
  await client.end().catch(() => {});
}

run("pnpm", ["db:migrate"]);
