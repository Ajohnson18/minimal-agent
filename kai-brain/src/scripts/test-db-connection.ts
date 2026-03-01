/**
 * Test Somethings DB connection
 * Usage: npx tsx src/scripts/test-db-connection.ts
 */
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

async function main() {
  console.log("=== Somethings DB Connection Test ===\n");

  const host = process.env.SOMETHINGS_DB_HOST || "localhost";
  const port = parseInt(process.env.SOMETHINGS_DB_PORT || "5433");
  const user = process.env.SOMETHINGS_DB_USER || "somethings";
  const password = process.env.SOMETHINGS_DB_PASSWORD;
  const database = process.env.SOMETHINGS_DB_NAME || "production";
  const sslEnv = process.env.SOMETHINGS_DB_SSL;

  console.log(`Host: ${host}:${port}`);
  console.log(`User: ${user}`);
  console.log(`Database: ${database}`);
  console.log(`Password: ${password ? "***" + password.slice(-4) : "(not set)"}`);
  console.log(`SSL env: ${sslEnv}\n`);

  // Try with SSL first (rejectUnauthorized: false), then without
  for (const sslConfig of [
    { label: "SSL on (rejectUnauthorized=false)", ssl: { rejectUnauthorized: false } as pg.ConnectionConfig["ssl"] },
    { label: "SSL off", ssl: false as const },
  ]) {
    console.log(`Trying: ${sslConfig.label}...`);
    const testPool = new Pool({ host, port, user, password, database, ssl: sslConfig.ssl, connectionTimeoutMillis: 5_000 });
    try {
      const c = await testPool.connect();
      c.release();
      await testPool.end();
      console.log(`  Success! Using: ${sslConfig.label}\n`);
      break;
    } catch (err) {
      console.log(`  Failed: ${(err as Error).message}`);
      await testPool.end();
    }
  }

  const pool = new Pool({
    host,
    port,
    user,
    password,
    database,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
  });

  try {
    console.log("Connecting...");
    const client = await pool.connect();
    console.log("Connected!\n");

    // Test 1: Count users
    const users = await client.query(
      "SELECT COUNT(*) as count FROM users WHERE deactivated = false"
    );
    console.log(`Active users: ${users.rows[0].count}`);

    // Test 2: Count by role
    const roles = await client.query(
      "SELECT role, COUNT(*) as count FROM users WHERE deactivated = false GROUP BY role ORDER BY count DESC"
    );
    console.log("\nUsers by role:");
    for (const row of roles.rows) {
      console.log(`  ${row.role}: ${row.count}`);
    }

    // Test 3: Reporting tables
    try {
      const metrics = await client.query(
        "SELECT MAX(record_created_at) as latest FROM reporting.mentee_metrics"
      );
      console.log(
        `\nLatest mentee_metrics: ${metrics.rows[0].latest || "no data"}`
      );
    } catch {
      console.log("\nreporting.mentee_metrics: table not found or empty");
    }

    // Test 4: Active mentorships
    const mentorships = await client.query(
      "SELECT COUNT(*) as count FROM mentorships WHERE status = 'active' AND deactivated = false"
    );
    console.log(`Active mentorships: ${mentorships.rows[0].count}`);

    client.release();
    console.log("\n=== All tests passed! ===");
  } catch (error) {
    console.error(
      "\nConnection FAILED:",
      error instanceof Error ? error.message : error
    );
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
