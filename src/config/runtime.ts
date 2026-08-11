export type DeployMode = "standalone" | "managed";

const DEFAULT_MANAGED_TOKEN_ENDPOINT = "/managed/session/token";
const DEFAULT_MANAGED_PROFILE_PATH = "/profile";
const DEFAULT_MANAGED_ADMIN_PATH = "/admin";
const DEFAULT_MANAGED_JWT_AUDIENCE = "nuvopic";

export function getDeployMode(): DeployMode {
  return process.env.DEPLOY_MODE === "managed" ? "managed" : "standalone";
}

export function isManagedMode(): boolean {
  return getDeployMode() === "managed";
}

export function isStandaloneMode(): boolean {
  return getDeployMode() === "standalone";
}

export function getManagedTokenEndpoint(): string {
  return process.env.MANAGED_TOKEN_ENDPOINT ?? DEFAULT_MANAGED_TOKEN_ENDPOINT;
}

export function getManagedProfilePath(): string {
  return process.env.MANAGED_PROFILE_PATH ?? DEFAULT_MANAGED_PROFILE_PATH;
}

export function getManagedAdminPath(): string {
  return process.env.MANAGED_ADMIN_PATH ?? DEFAULT_MANAGED_ADMIN_PATH;
}

export function getManagedJwtAudience(): string {
  return process.env.MANAGED_JWT_AUDIENCE ?? DEFAULT_MANAGED_JWT_AUDIENCE;
}

export function getManagedJwtIssuer(): string | null {
  return process.env.MANAGED_JWT_ISSUER?.trim() || null;
}

export function getManagedJwksJson(): string | null {
  return process.env.MANAGED_JWKS_JSON?.trim() || null;
}

export function getManagedJwksFile(): string | null {
  return process.env.MANAGED_JWKS_FILE?.trim() || null;
}

export function getManagedJwksUrl(): string | null {
  return process.env.MANAGED_JWKS_URL?.trim() || null;
}

export function getWorkspaceDirectoryJson(): string | null {
  return process.env.MANAGED_WORKSPACE_DIRECTORY_JSON?.trim() || null;
}

export function getWorkspaceDirectoryUrl(): string | null {
  return process.env.MANAGED_WORKSPACE_DIRECTORY_URL?.trim() || null;
}

export function getWorkspaceDirectoryListUrl(): string | null {
  const configured = process.env.MANAGED_WORKSPACE_DIRECTORY_LIST_URL?.trim();
  if (configured) return configured;
  const resolveUrl = getWorkspaceDirectoryUrl();
  if (!resolveUrl) return null;
  const url = new URL(resolveUrl);
  url.pathname = url.pathname.replace(/\/resolve\/?$/, "");
  url.search = "";
  return url.toString();
}

export function getWorkspaceDirectoryToken(): string | null {
  return process.env.MANAGED_WORKSPACE_DIRECTORY_TOKEN?.trim() || null;
}

export type GpuMeteringMode = "disabled" | "shadow" | "enforce";

export function getGpuMeteringMode(): GpuMeteringMode {
  if (!isManagedMode()) return "disabled";
  const configured = process.env.GPU_METERING_MODE?.trim().toLowerCase();
  if (configured === "disabled" || configured === "shadow" || configured === "enforce") {
    return configured;
  }
  return getGpuMeteringUrl() && getGpuMeteringToken() ? "shadow" : "disabled";
}

export function getGpuMeteringUrl(): string | null {
  return process.env.GPU_METERING_URL?.trim().replace(/\/+$/, "") || null;
}

export function getGpuMeteringToken(): string | null {
  return process.env.GPU_METERING_SERVICE_TOKEN?.trim() || null;
}

export function getGpuMeteringRequestTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.GPU_METERING_REQUEST_TIMEOUT_MS ?? "10000", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10_000;
}

export function getWorkspaceDirectoryCacheTtlMs(): number {
  const raw = parseInt(process.env.MANAGED_WORKSPACE_DIRECTORY_CACHE_TTL_MS ?? "60000", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 60000;
}

export function getJwksCacheTtlMs(): number {
  const raw = parseInt(process.env.MANAGED_JWKS_CACHE_TTL_MS ?? "300000", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 300000;
}

export function getSettingsKek(): string | null {
  return process.env.SETTINGS_KEK?.trim() || null;
}
