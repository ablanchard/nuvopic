import { logger } from "../logger.js";
import {
  getWorkspaceDirectoryCacheTtlMs,
  getWorkspaceDirectoryJson,
  getWorkspaceDirectoryToken,
  getWorkspaceDirectoryUrl,
} from "../config/runtime.js";

export interface WorkspaceDirectoryEntry {
  workspaceId: string;
  databaseUrl: string;
  databaseSsl?: boolean;
  status?: "active" | "disabled";
}

interface CachedWorkspaceEntry {
  entry: WorkspaceDirectoryEntry;
  expiresAt: number;
}

type WorkspaceDirectoryMap =
  | Record<string, Omit<WorkspaceDirectoryEntry, "workspaceId">>
  | WorkspaceDirectoryEntry[];

const cache = new Map<string, CachedWorkspaceEntry>();

function normalizeEntry(
  workspaceId: string,
  entry: Partial<WorkspaceDirectoryEntry> & { databaseUrl?: string; connectionString?: string }
): WorkspaceDirectoryEntry {
  const databaseUrl = entry.databaseUrl ?? entry.connectionString;
  if (!databaseUrl?.trim()) {
    throw new Error(`Workspace "${workspaceId}" is missing a database URL`);
  }

  return {
    workspaceId,
    databaseUrl: databaseUrl.trim(),
    databaseSsl: entry.databaseSsl,
    status: entry.status ?? "active",
  };
}

function resolveFromStaticJson(workspaceId: string): WorkspaceDirectoryEntry | null {
  const raw = getWorkspaceDirectoryJson();
  if (!raw) return null;

  const parsed = JSON.parse(raw) as WorkspaceDirectoryMap;

  if (Array.isArray(parsed)) {
    const match = parsed.find((entry) => entry.workspaceId === workspaceId);
    return match ? normalizeEntry(workspaceId, match) : null;
  }

  const entry = parsed[workspaceId];
  return entry ? normalizeEntry(workspaceId, entry) : null;
}

async function resolveFromRemoteDirectory(workspaceId: string): Promise<WorkspaceDirectoryEntry | null> {
  const url = getWorkspaceDirectoryUrl();
  if (!url) return null;

  const endpoint = new URL(url);
  endpoint.searchParams.set("workspaceId", workspaceId);

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  const bearer = getWorkspaceDirectoryToken();
  if (bearer) {
    headers.Authorization = `Bearer ${bearer}`;
  }

  const response = await fetch(endpoint, { headers });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Workspace directory lookup failed with ${response.status}`);
  }

  const data = (await response.json()) as
    | (Partial<WorkspaceDirectoryEntry> & { workspaceId?: string; databaseUrl?: string; connectionString?: string })
    | { workspace: Partial<WorkspaceDirectoryEntry> & { workspaceId?: string; databaseUrl?: string; connectionString?: string } };

  const entry = "workspace" in data ? data.workspace : data;
  const resolvedWorkspaceId = entry.workspaceId ?? workspaceId;
  return normalizeEntry(resolvedWorkspaceId, entry);
}

function getCachedEntry(workspaceId: string): WorkspaceDirectoryEntry | null {
  const cached = cache.get(workspaceId);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    cache.delete(workspaceId);
    return null;
  }
  return cached.entry;
}

function setCachedEntry(entry: WorkspaceDirectoryEntry): WorkspaceDirectoryEntry {
  cache.set(entry.workspaceId, {
    entry,
    expiresAt: Date.now() + getWorkspaceDirectoryCacheTtlMs(),
  });
  return entry;
}

export async function resolveWorkspaceDirectoryEntry(
  workspaceId: string
): Promise<WorkspaceDirectoryEntry> {
  const cached = getCachedEntry(workspaceId);
  if (cached) {
    return cached;
  }

  const fromStatic = resolveFromStaticJson(workspaceId);
  if (fromStatic) {
    return setCachedEntry(fromStatic);
  }

  const fromRemote = await resolveFromRemoteDirectory(workspaceId);
  if (fromRemote) {
    return setCachedEntry(fromRemote);
  }

  logger.warn(`Workspace directory lookup failed for workspace=${workspaceId}`);
  throw new Error(`Unknown workspace: ${workspaceId}`);
}

export function clearWorkspaceDirectoryCache(): void {
  cache.clear();
}
