import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Client } from "pg";

const MIGRATION_FILE_RE = /^\d{4}_.+\.sql$/;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const migrationsDir = path.join(rootDir, "drizzle");
const journalPath = path.join(migrationsDir, "meta", "_journal.json");

dotenv.config({ path: path.join(rootDir, ".env") });
dotenv.config({ path: path.join(rootDir, ".env.local"), override: true });

const connectionString =
  process.env.AVA_TEST_DB_URL ?? process.env.DATABASE_URL ?? "";

if (!connectionString) {
  console.error(
    "Database URL is required. Set AVA_TEST_DB_URL or DATABASE_URL before running db:baseline.",
  );
  process.exit(1);
}

if (!fs.existsSync(journalPath)) {
  console.error(`Journal file not found: ${journalPath}`);
  process.exit(1);
}

const rawJournal = fs.readFileSync(journalPath, "utf8");
const journal = JSON.parse(rawJournal);
const entries = Array.isArray(journal?.entries) ? journal.entries : [];

if (entries.length === 0) {
  console.error(
    "No migration entries found in drizzle/meta/_journal.json. Refusing to baseline empty history.",
  );
  process.exit(1);
}

const journalEntries = entries
  .map((entry) => {
    const idx = Number(entry?.idx);
    const tag = String(entry?.tag ?? "").trim();
    const folderMillis = Number(entry?.when);

    if (!Number.isFinite(idx) || !tag || !Number.isFinite(folderMillis)) {
      throw new Error(`Invalid journal entry: ${JSON.stringify(entry)}`);
    }

    return {
      idx,
      tag,
      folderMillis,
    };
  })
  .sort((a, b) => a.idx - b.idx);

for (let i = 0; i < journalEntries.length; i += 1) {
  if (journalEntries[i].idx !== i) {
    throw new Error(
      `Journal index sequence is invalid at position ${i}; expected idx=${i}, found idx=${journalEntries[i].idx}.`,
    );
  }
}

const sqlTags = fs
  .readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && MIGRATION_FILE_RE.test(entry.name))
  .map((entry) => entry.name.replace(/\.sql$/i, ""))
  .sort();

const journalTags = journalEntries.map((entry) => entry.tag);
const missingFromJournal = sqlTags.filter((tag) => !journalTags.includes(tag));
const missingSqlFiles = journalTags.filter((tag) => !sqlTags.includes(tag));

if (missingFromJournal.length > 0 || missingSqlFiles.length > 0) {
  throw new Error(
    `Journal/sql mismatch detected. missingFromJournal=[${missingFromJournal.join(", ")}] missingSqlFiles=[${missingSqlFiles.join(", ")}]`,
  );
}

const migrations = journalEntries.map((entry) => {
  const sqlPath = path.join(migrationsDir, `${entry.tag}.sql`);
  const sql = fs.readFileSync(sqlPath, "utf8");
  const hash = crypto.createHash("sha256").update(sql).digest("hex");

  return {
    ...entry,
    hash,
  };
});

const client = new Client({ connectionString });

try {
  await client.connect();
  await client.query("BEGIN");

  await client.query("CREATE SCHEMA IF NOT EXISTS drizzle;");
  await client.query(`
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    );
  `);

  const existingRows = await client.query(
    "SELECT hash, created_at FROM drizzle.__drizzle_migrations",
  );

  const existingByCreatedAt = new Map();
  const existingHashes = new Set();
  for (const row of existingRows.rows) {
    const hash = String(row.hash);
    const createdAt = Number(row.created_at);
    existingHashes.add(hash);
    if (Number.isFinite(createdAt)) {
      const seenHash = existingByCreatedAt.get(createdAt);
      if (seenHash && seenHash !== hash) {
        throw new Error(
          `Database contains conflicting migration hashes at created_at=${createdAt}: ${seenHash} vs ${hash}`,
        );
      }
      existingByCreatedAt.set(createdAt, hash);
    }
  }

  let inserted = 0;
  let skippedByCreatedAt = 0;
  let skippedByHash = 0;
  for (const migration of migrations) {
    const existingHashAtCreatedAt = existingByCreatedAt.get(migration.folderMillis);
    if (existingHashAtCreatedAt) {
      if (existingHashAtCreatedAt !== migration.hash) {
        throw new Error(
          `Hash mismatch for created_at=${migration.folderMillis}: db=${existingHashAtCreatedAt} local=${migration.hash}`,
        );
      }
      skippedByCreatedAt += 1;
      continue;
    }

    // If hash already exists at another created_at, treat as already applied.
    if (existingHashes.has(migration.hash)) {
      skippedByHash += 1;
      continue;
    }

    await client.query(
      `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`,
      [migration.hash, migration.folderMillis],
    );
    existingHashes.add(migration.hash);
    existingByCreatedAt.set(migration.folderMillis, migration.hash);
    inserted += 1;
  }

  await client.query("COMMIT");
  console.log(
    `Migration baseline complete. inserted=${inserted} skippedByCreatedAt=${skippedByCreatedAt} skippedByHash=${skippedByHash} total=${migrations.length}`,
  );
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(
    `Failed to baseline migrations: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
