import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { Pool } from "pg";

dotenv.config();

const migrationsDir = path.resolve(__dirname, "../../migrations");
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to run migrations.");
}

const sslRootCertPath = process.env.PGSSLROOTCERT;
const sslServerName = process.env.PGSSL_SERVERNAME;
const sslMode = process.env.PGSSLMODE ?? "require";
const rejectUnauthorized = process.env.PGSSLREJECTUNAUTHORIZED !== "false";
const sslConfig =
  sslMode === "disable"
    ? undefined
    : {
        ca: sslRootCertPath ? fs.readFileSync(sslRootCertPath, "utf-8") : undefined,
        rejectUnauthorized,
        servername: sslServerName,
      };

const pool = new Pool({ connectionString: databaseUrl, ssl: sslConfig });

const run = async () => {
  const client = await pool.connect();
  try {
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    );

    const appliedRows = await client.query<{ id: string }>("SELECT id FROM schema_migrations");
    const applied = new Set(appliedRows.rows.map((row) => row.id));

    const files = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`Applied migration ${file}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    client.release();
  }
};

run()
  .then(async () => {
    await pool.end();
  })
  .catch(async (error) => {
    console.error("Migration failed:", error);
    await pool.end();
    process.exit(1);
  });
