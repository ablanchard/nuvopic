import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import pg from "pg";

const { Pool } = pg;

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    console.error("DATABASE_URL environment variable is required");
    console.error("Example: DATABASE_URL=postgres://user:pass@host:5432/db");
    process.exit(1);
  }

  const ssl = process.env.DATABASE_SSL === "true"
    ? { rejectUnauthorized: false }
    : undefined;

  const pool = new Pool({
    connectionString,
    ssl,
  });

  try {
    console.log("Connecting to database...");
    await pool.query("SELECT 1");
    console.log("Connected!");

    const identity = await pool.query<{
      database_name: string;
      current_role: string;
      database_owner: string;
    }>(
      `SELECT current_database() AS database_name,
              current_user AS current_role,
              pg_get_userbyid(datdba) AS database_owner
       FROM pg_database
       WHERE datname = current_database()`
    );
    const databaseIdentity = identity.rows[0];
    if (
      databaseIdentity?.database_name.startsWith("nuvopic_ws_") &&
      databaseIdentity.current_role !== databaseIdentity.database_owner
    ) {
      throw new Error(
        `Refusing to migrate workspace database as ${databaseIdentity.current_role}; ` +
          `use its owning runtime role ${databaseIdentity.database_owner}. ` +
          `Running as an administrator would create tables the data plane cannot access.`
      );
    }

    // Read schema file
    const schemaPath = path.join(process.cwd(), "src", "db", "schema.sql");
    const schema = fs.readFileSync(schemaPath, "utf-8");

    console.log("Executing schema...");
    await pool.query(schema);

    console.log("Database initialized successfully!");

    // Show table counts
    const tables = ["photos", "faces", "persons", "tags", "photo_tags"];
    console.log("\nTable status:");

    for (const table of tables) {
      try {
        const result = await pool.query(`SELECT COUNT(*) FROM ${table}`);
        console.log(`  ${table}: ${result.rows[0].count} rows`);
      } catch {
        console.log(`  ${table}: (table may not exist yet)`);
      }
    }
  } catch (error) {
    console.error("Error initializing database:", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
