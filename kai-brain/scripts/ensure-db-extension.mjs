import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Client } from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

dotenv.config({ path: path.join(rootDir, ".env") });
dotenv.config({ path: path.join(rootDir, ".env.local"), override: true });

const connectionString =
  process.env.AVA_TEST_DB_URL ?? process.env.DATABASE_URL ?? "";

if (!connectionString) {
  console.error(
    "Database URL is required. Set AVA_TEST_DB_URL or DATABASE_URL before running db:prepare.",
  );
  process.exit(1);
}

const client = new Client({ connectionString });

try {
  await client.connect();
  await client.query("CREATE EXTENSION IF NOT EXISTS vector;");
  const result = await client.query(
    "SELECT 1 FROM pg_extension WHERE extname = 'vector' LIMIT 1;",
  );

  if (result.rowCount !== 1) {
    throw new Error("pgvector extension verification failed");
  }
} finally {
  await client.end().catch(() => {});
}
