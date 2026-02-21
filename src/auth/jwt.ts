import crypto from "node:crypto";

const ALGORITHM = "sha256";

interface JwtPayload {
  sub: string;
  iat: number;
  exp: number;
}

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET environment variable is required");
  }
  return secret;
}

function base64UrlEncode(data: string): string {
  return Buffer.from(data).toString("base64url");
}

function base64UrlDecode(data: string): string {
  return Buffer.from(data, "base64url").toString("utf-8");
}

function sign(payload: string, secret: string): string {
  return crypto
    .createHmac(ALGORITHM, secret)
    .update(payload)
    .digest("base64url");
}

export function createToken(subject: string, expiresInSeconds = 86400 * 7): string {
  const secret = getSecret();
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64UrlEncode(
    JSON.stringify({
      sub: subject,
      iat: now,
      exp: now + expiresInSeconds,
    } satisfies JwtPayload)
  );

  const signature = sign(`${header}.${payload}`, secret);
  return `${header}.${payload}.${signature}`;
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    const secret = getSecret();
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [header, payload, signature] = parts;
    const expectedSignature = sign(`${header}.${payload}`, secret);

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      return null;
    }

    const decoded = JSON.parse(base64UrlDecode(payload)) as JwtPayload;
    const now = Math.floor(Date.now() / 1000);

    if (decoded.exp < now) {
      return null;
    }

    return decoded;
  } catch {
    return null;
  }
}
