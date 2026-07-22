import crypto from "node:crypto";
import * as fs from "node:fs";
import {
  getJwksCacheTtlMs,
  getManagedJwksFile,
  getManagedJwksJson,
  getManagedJwksUrl,
  getManagedJwtAudience,
  getManagedJwtIssuer,
} from "../config/runtime.js";

interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

interface Jwk {
  kty: string;
  kid?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

export interface ManagedJwtClaims {
  iss?: string;
  aud?: string | string[];
  sub: string;
  workspace_id: string;
  role?: string;
  iat?: number;
  exp?: number;
  nbf?: number;
}

interface JsonWebKeySet {
  keys: Jwk[];
}

interface CachedJwks {
  keys: Jwk[];
  expiresAt: number;
}

const SUPPORTED_ALGORITHMS = new Map<string, string>([
  ["RS256", "RSA-SHA256"],
  ["ES256", "sha256"],
  ["ES384", "sha384"],
]);

let cachedJwks: CachedJwks | null = null;

function base64UrlDecodeToBuffer(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function parseJson<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf-8")) as T;
}

function loadStaticJwks(): Jwk[] | null {
  const inline = getManagedJwksJson();
  if (inline) {
    const parsed = JSON.parse(inline) as JsonWebKeySet | Jwk[];
    return Array.isArray(parsed) ? parsed : parsed.keys;
  }

  const file = getManagedJwksFile();
  if (file) {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as JsonWebKeySet | Jwk[];
    return Array.isArray(parsed) ? parsed : parsed.keys;
  }

  return null;
}

async function loadRemoteJwks(): Promise<Jwk[] | null> {
  const url = getManagedJwksUrl();
  if (!url) return null;

  if (cachedJwks && cachedJwks.expiresAt > Date.now()) {
    return cachedJwks.keys;
  }

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`JWKS fetch failed with ${response.status}`);
  }

  const parsed = (await response.json()) as JsonWebKeySet | Jwk[];
  const keys = Array.isArray(parsed) ? parsed : parsed.keys;
  cachedJwks = {
    keys,
    expiresAt: Date.now() + getJwksCacheTtlMs(),
  };
  return keys;
}

async function getJwks(): Promise<Jwk[]> {
  const staticKeys = loadStaticJwks();
  if (staticKeys?.length) {
    return staticKeys;
  }

  const remoteKeys = await loadRemoteJwks();
  if (remoteKeys?.length) {
    return remoteKeys;
  }

  throw new Error(
    "Managed mode requires MANAGED_JWKS_JSON, MANAGED_JWKS_FILE, or MANAGED_JWKS_URL"
  );
}

function resolveJwk(
  keys: Jwk[],
  header: JwtHeader
): Jwk {
  if (header.kid) {
    const byKid = keys.find((key) => key.kid === header.kid);
    if (byKid) return byKid;
  }

  if (keys.length === 1) {
    return keys[0];
  }

  throw new Error("Unable to resolve signing key from JWKS");
}

function verifySignature(
  header: JwtHeader,
  signingInput: string,
  signature: Buffer,
  jwk: Jwk
): boolean {
  const algorithm = header.alg ? SUPPORTED_ALGORITHMS.get(header.alg) : null;
  if (!algorithm) {
    throw new Error(`Unsupported managed JWT algorithm: ${header.alg ?? "unknown"}`);
  }

  const publicKey = crypto.createPublicKey({
    key: jwk as crypto.JsonWebKey,
    format: "jwk",
  });
  return crypto.verify(algorithm, Buffer.from(signingInput), publicKey, signature);
}

function audienceMatches(audience: string | string[] | undefined, expected: string): boolean {
  if (!audience) return false;
  return Array.isArray(audience) ? audience.includes(expected) : audience === expected;
}

function validateClaims(claims: ManagedJwtClaims): ManagedJwtClaims | null {
  if (!claims.sub || !claims.workspace_id) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (claims.exp !== undefined && claims.exp <= now) {
    return null;
  }
  if (claims.nbf !== undefined && claims.nbf > now) {
    return null;
  }

  const expectedIssuer = getManagedJwtIssuer();
  if (expectedIssuer && claims.iss !== expectedIssuer) {
    return null;
  }

  if (!audienceMatches(claims.aud, getManagedJwtAudience())) {
    return null;
  }

  return claims;
}

export async function verifyManagedJwt(token: string): Promise<ManagedJwtClaims | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }

    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = parseJson<JwtHeader>(encodedHeader);
    const claims = parseJson<ManagedJwtClaims>(encodedPayload);
    const signature = base64UrlDecodeToBuffer(encodedSignature);
    const jwks = await getJwks();
    const jwk = resolveJwk(jwks, header);
    const verified = verifySignature(header, `${encodedHeader}.${encodedPayload}`, signature, jwk);
    if (!verified) {
      return null;
    }

    return validateClaims(claims);
  } catch {
    return null;
  }
}

export function clearManagedJwksCache(): void {
  cachedJwks = null;
}
