import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import { isManagedMode } from "../config/runtime.js";
import {
  resolveWorkspaceDirectoryEntry,
  type WorkspaceDirectoryEntry,
} from "../managed/workspace-directory.js";

const { Pool } = pg;

export interface DatabaseContextValue {
  pool: pg.Pool;
  cacheKey: string;
  workspaceId?: string;
}

const dbContext = new AsyncLocalStorage<DatabaseContextValue>();

let standalonePool: pg.Pool | null = null;
const pooledConnections = new Map<string, pg.Pool>();

function shouldUseSsl(connectionString: string, explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return (
    process.env.DATABASE_SSL === "true" ||
    connectionString.includes("sslmode=require")
  );
}

function createPool(
  connectionString: string,
  sslEnabled: boolean
): pg.Pool {
  return new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    ssl: sslEnabled ? { rejectUnauthorized: false } : undefined,
  });
}

function getOrCreatePool(
  connectionString: string,
  sslEnabled: boolean,
  cacheKey: string
): pg.Pool {
  let pool = pooledConnections.get(cacheKey);
  if (!pool) {
    pool = createPool(connectionString, sslEnabled);
    pooledConnections.set(cacheKey, pool);
  }
  return pool;
}

function getStandalonePool(): pg.Pool {
  if (!standalonePool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL environment variable is required");
    }

    standalonePool = createPool(
      connectionString,
      shouldUseSsl(connectionString)
    );
  }

  return standalonePool;
}

export function getPool(): pg.Pool {
  if (!isManagedMode()) {
    return getStandalonePool();
  }

  const context = dbContext.getStore();
  if (!context) {
    throw new Error(
      "Managed mode database access requires a workspace-scoped request context"
    );
  }

  return context.pool;
}

export function getCurrentDatabaseContext(): DatabaseContextValue | null {
  return dbContext.getStore() ?? null;
}

export function getCurrentDatabaseCacheKey(): string {
  return getCurrentDatabaseContext()?.cacheKey ?? "standalone";
}

export function getCurrentWorkspaceId(): string | null {
  return getCurrentDatabaseContext()?.workspaceId ?? null;
}

export function runWithDatabaseContext<T>(
  context: DatabaseContextValue,
  fn: () => Promise<T>
): Promise<T> {
  return dbContext.run(context, fn);
}

function getManagedPoolContext(entry: WorkspaceDirectoryEntry): DatabaseContextValue {
  const sslEnabled = shouldUseSsl(entry.databaseUrl, entry.databaseSsl);
  const cacheKey = `workspace:${entry.workspaceId}:${entry.databaseUrl}:${sslEnabled ? "ssl" : "plain"}`;
  const pool = getOrCreatePool(entry.databaseUrl, sslEnabled, cacheKey);

  return {
    pool,
    cacheKey,
    workspaceId: entry.workspaceId,
  };
}

export async function runWithWorkspaceContext<T>(
  workspaceId: string,
  fn: () => Promise<T>
): Promise<T> {
  const entry = await resolveWorkspaceDirectoryEntry(workspaceId);
  if (entry.status === "disabled") {
    throw new Error(`Workspace "${workspaceId}" is disabled`);
  }

  const context = getManagedPoolContext(entry);
  return runWithDatabaseContext(context, fn);
}

export async function query<T extends pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  const pool = getPool();
  return pool.query<T>(text, params);
}

export async function withTransaction<T>(
  operation: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  const closures: Promise<void>[] = [];

  if (standalonePool) {
    closures.push(standalonePool.end());
    standalonePool = null;
  }

  for (const pool of pooledConnections.values()) {
    closures.push(pool.end());
  }
  pooledConnections.clear();

  await Promise.all(closures);
}
