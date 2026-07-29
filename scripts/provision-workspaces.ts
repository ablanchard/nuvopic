import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const { Pool } = pg;

interface PendingWorkspace {
  id: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function workspaceDatabaseNames(workspaceId: string): {
  databaseName: string;
  databaseRole: string;
} {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspaceId)) {
    throw new Error(`Workspace ID is not a canonical UUID: ${workspaceId}`);
  }

  return {
    databaseName: `nuvopic_ws_${workspaceId.toLowerCase().replaceAll("-", "_")}`,
    databaseRole: `nuvopic_ws_${workspaceId.toLowerCase().replaceAll("-", "")}`,
  };
}

function workspaceDatabaseUrl(
  adminDatabaseUrl: string,
  databaseName: string,
  databaseRole: string,
  databasePassword: string
): string {
  const url = new URL(adminDatabaseUrl);
  url.username = databaseRole;
  url.password = databasePassword;
  url.pathname = `/${databaseName}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function databaseUrlForDatabase(baseDatabaseUrl: string, databaseName: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${databaseName}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, "postgres://[redacted]@");
}

async function provisionWorkspace(
  controlPool: pg.Pool,
  adminDatabaseUrl: string,
  schema: string,
  workspaceId: string,
  databaseSsl: boolean
): Promise<void> {
  const controlClient = await controlPool.connect();
  let locked = false;

  try {
    const lockResult = await controlClient.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
      [workspaceId]
    );
    locked = lockResult.rows[0]?.locked === true;
    if (!locked) return;

    const workspaceResult = await controlClient.query<{
      database_url: string | null;
      status: string;
    }>(
      "SELECT database_url, status FROM workspace WHERE id = $1",
      [workspaceId]
    );
    const workspace = workspaceResult.rows[0];
    if (!workspace || workspace.database_url || workspace.status !== "active") {
      return;
    }

    const { databaseName, databaseRole } = workspaceDatabaseNames(workspaceId);
    const quotedDatabaseName = quoteIdentifier(databaseName);
    const quotedDatabaseRole = quoteIdentifier(databaseRole);
    const databasePassword = crypto.randomBytes(32).toString("hex");
    const quotedDatabasePassword = quoteLiteral(databasePassword);

    const roleResult = await controlClient.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
      [databaseRole]
    );
    if (roleResult.rows[0]?.exists) {
      await controlClient.query(
        `ALTER ROLE ${quotedDatabaseRole} WITH LOGIN PASSWORD ${quotedDatabasePassword} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`
      );
    } else {
      await controlClient.query(
        `CREATE ROLE ${quotedDatabaseRole} WITH LOGIN PASSWORD ${quotedDatabasePassword} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`
      );
    }

    const databaseResult = await controlClient.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
      [databaseName]
    );
    if (databaseResult.rows[0]?.exists) {
      await controlClient.query(
        `ALTER DATABASE ${quotedDatabaseName} OWNER TO ${quotedDatabaseRole}`
      );
    } else {
      await controlClient.query(
        `CREATE DATABASE ${quotedDatabaseName} OWNER ${quotedDatabaseRole}`
      );
    }

    const databaseUrl = workspaceDatabaseUrl(
      adminDatabaseUrl,
      databaseName,
      databaseRole,
      databasePassword
    );
    const adminWorkspacePool = new Pool({
      connectionString: databaseUrlForDatabase(adminDatabaseUrl, databaseName),
      ssl: databaseSsl ? { rejectUnauthorized: false } : undefined,
      max: 1,
    });

    try {
      await adminWorkspacePool.query("CREATE EXTENSION IF NOT EXISTS vector");
    } finally {
      await adminWorkspacePool.end();
    }

    const workspacePool = new Pool({
      connectionString: databaseUrl,
      ssl: databaseSsl ? { rejectUnauthorized: false } : undefined,
      max: 1,
    });

    try {
      await workspacePool.query(schema);
    } finally {
      await workspacePool.end();
    }

    const updateResult = await controlClient.query(
      `UPDATE workspace
       SET database_url = $2,
           database_ssl = $3,
           status = 'active'
       WHERE id = $1
         AND database_url IS NULL`,
      [workspaceId, databaseUrl, databaseSsl]
    );

    if ((updateResult.rowCount ?? 0) === 1) {
      console.log(`Provisioned workspace ${workspaceId} as ${databaseName}.`);
    }
  } finally {
    if (locked) {
      await controlClient.query(
        "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
        [workspaceId]
      );
    }
    controlClient.release();
  }
}

async function main(): Promise<void> {
  const adminDatabaseUrl = requiredEnv("CONTROL_DATABASE_ADMIN_URL");
  const pollIntervalSeconds = parsePositiveInteger(
    process.env.PROVISIONER_POLL_INTERVAL_SECONDS,
    3
  );
  const batchSize = parsePositiveInteger(process.env.PROVISIONER_BATCH_SIZE, 10);
  const databaseSsl = process.env.WORKSPACE_DATABASE_SSL === "true";
  const runOnce = process.env.PROVISIONER_RUN_ONCE === "true";
  const schemaPath = path.join(process.cwd(), "src", "db", "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf8");
  const controlPool = new Pool({
    connectionString: adminDatabaseUrl,
    ssl: false,
    max: 2,
  });
  let stopping = false;

  const stop = (): void => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log("Workspace provisioner started.");

  try {
    do {
      try {
        const pending = await controlPool.query<PendingWorkspace>(
          `SELECT id
           FROM workspace
           WHERE database_url IS NULL
             AND status = 'active'
           ORDER BY created_at
           LIMIT $1`,
          [batchSize]
        );

        for (const workspace of pending.rows) {
          if (stopping) break;
          try {
            await provisionWorkspace(
              controlPool,
              adminDatabaseUrl,
              schema,
              workspace.id,
              databaseSsl
            );
          } catch (error) {
            console.error(
              `Workspace ${workspace.id} provisioning failed: ${safeErrorMessage(error)}`
            );
          }
        }
      } catch (error) {
        console.error(`Provisioning scan failed: ${safeErrorMessage(error)}`);
      }

      if (!runOnce && !stopping) {
        await new Promise((resolve) =>
          setTimeout(resolve, pollIntervalSeconds * 1000)
        );
      }
    } while (!runOnce && !stopping);
  } finally {
    await controlPool.end();
    console.log("Workspace provisioner stopped.");
  }
}

main().catch((error) => {
  console.error(`Workspace provisioner could not start: ${safeErrorMessage(error)}`);
  process.exit(1);
});
