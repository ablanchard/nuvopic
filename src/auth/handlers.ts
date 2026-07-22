import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createToken, verifyToken } from "./jwt.js";
import { verifyManagedJwt } from "./managed-jwt.js";
import { logger } from "../logger.js";
import {
  getManagedProfilePath,
  isManagedMode,
  isStandaloneMode,
} from "../config/runtime.js";
import { runWithWorkspaceContext } from "../db/client.js";

const COOKIE_NAME = "session";
const LOGIN_PATH = "/login";
const SESSION_DURATION = 86400 * 7; // 7 days
const PUBLIC_API_PATHS = new Set(["/api/v1/runtime"]);

export interface AuthInfo {
  subject: string;
  role: string;
  workspaceId: string | null;
  mode: "standalone" | "managed";
}

function getPassword(): string {
  const password = process.env.AUTH_PASSWORD;
  if (!password) {
    throw new Error("AUTH_PASSWORD environment variable is required");
  }
  return password;
}

function getBearerToken(c: Context): string | null {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }
  return authHeader.slice("Bearer ".length).trim() || null;
}

function setAuthInfo(c: Context, auth: AuthInfo): void {
  c.set("auth", auth);
}

function buildDefaultStandaloneAuth(): AuthInfo {
  return {
    subject: "admin",
    role: "owner",
    workspaceId: null,
    mode: "standalone",
  };
}

function isProtectedApiPath(path: string): boolean {
  return path.startsWith("/api/") || path === "/process";
}

/**
 * Returns true if standalone password auth is enabled.
 */
export function isAuthEnabled(): boolean {
  return isManagedMode() || !!process.env.AUTH_PASSWORD;
}

export function getAuthInfo(c: Context): AuthInfo {
  return (c.get("auth") as AuthInfo | undefined) ?? buildDefaultStandaloneAuth();
}

async function managedAuthMiddleware(c: Context, next: Next) {
  const path = new URL(c.req.url).pathname;

  if (PUBLIC_API_PATHS.has(path) || !isProtectedApiPath(path)) {
    return next();
  }

  const token = getBearerToken(c);
  if (!token) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const claims = await verifyManagedJwt(token);
  if (!claims) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    return await runWithWorkspaceContext(claims.workspace_id, async () => {
      setAuthInfo(c, {
        subject: claims.sub,
        role: claims.role ?? "owner",
        workspaceId: claims.workspace_id,
        mode: "managed",
      });
      return next();
    });
  } catch (error) {
    logger.error("Managed workspace resolution failed:", error);
    return c.json({ error: "Workspace unavailable" }, 503);
  }
}

async function standaloneAuthMiddleware(c: Context, next: Next) {
  const path = new URL(c.req.url).pathname;

  if (!process.env.AUTH_PASSWORD) {
    setAuthInfo(c, buildDefaultStandaloneAuth());
    return next();
  }

  if (path === "/health" || path === LOGIN_PATH || PUBLIC_API_PATHS.has(path)) {
    return next();
  }

  const token = getCookie(c, COOKIE_NAME);
  if (token) {
    const payload = verifyToken(token);
    if (payload) {
      setAuthInfo(c, buildDefaultStandaloneAuth());
      return next();
    }
  }

  if (path.startsWith("/api/") || path === "/process") {
    return c.json({ error: "Unauthorized" }, 401);
  }

  return c.redirect(LOGIN_PATH);
}

/**
 * Auth middleware.
 * - Standalone mode uses the built-in password + cookie flow.
 * - Managed mode validates bearer JWTs only for API/process routes.
 */
export async function authMiddleware(c: Context, next: Next) {
  if (isManagedMode()) {
    return managedAuthMiddleware(c, next);
  }
  return standaloneAuthMiddleware(c, next);
}

/**
 * Handle GET /login - serve the login page.
 */
export function handleLoginPage(c: Context) {
  if (!isStandaloneMode()) {
    return c.redirect(getManagedProfilePath());
  }

  const token = getCookie(c, COOKIE_NAME);
  if (token && verifyToken(token)) {
    return c.redirect("/");
  }

  return c.html(loginPageHtml(c.req.query("error")));
}

/**
 * Handle POST /login - validate password, set session cookie.
 */
export async function handleLogin(c: Context) {
  if (!isStandaloneMode() || !process.env.AUTH_PASSWORD) {
    return c.redirect("/");
  }

  const body = await c.req.parseBody();
  const password = body["password"];

  if (typeof password !== "string" || password !== getPassword()) {
    logger.warn("Failed login attempt");
    return c.html(loginPageHtml("Invalid password"), 401);
  }

  const token = createToken("admin", SESSION_DURATION);

  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DURATION,
  });

  logger.info("Successful login");
  return c.redirect("/");
}

/**
 * Handle POST /logout - clear session cookie.
 */
export function handleLogout(c: Context) {
  if (!isStandaloneMode()) {
    return c.redirect(getManagedProfilePath());
  }

  deleteCookie(c, COOKIE_NAME, { path: "/" });
  return c.redirect(LOGIN_PATH);
}

function loginPageHtml(error?: string | undefined): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f0f0f;
      color: #e0e0e0;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .login-card {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 12px;
      padding: 2.5rem;
      width: 100%;
      max-width: 380px;
      margin: 1rem;
    }
    h1 {
      font-size: 1.5rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
      color: #fff;
    }
    p.subtitle {
      font-size: 0.875rem;
      color: #888;
      margin-bottom: 1.5rem;
    }
    label {
      display: block;
      font-size: 0.875rem;
      font-weight: 500;
      margin-bottom: 0.5rem;
      color: #ccc;
    }
    input[type="password"] {
      width: 100%;
      padding: 0.75rem;
      border: 1px solid #333;
      border-radius: 8px;
      background: #0f0f0f;
      color: #fff;
      font-size: 1rem;
      outline: none;
      transition: border-color 0.2s;
    }
    input[type="password"]:focus {
      border-color: #555;
    }
    button {
      width: 100%;
      padding: 0.75rem;
      margin-top: 1rem;
      background: #fff;
      color: #000;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:hover { background: #e0e0e0; }
    .error {
      background: #2d1515;
      border: 1px solid #5c2020;
      color: #f87171;
      padding: 0.75rem;
      border-radius: 8px;
      font-size: 0.875rem;
      margin-bottom: 1rem;
    }
  </style>
</head>
<body>
  <div class="login-card">
    <h1>Photos</h1>
    <p class="subtitle">Enter your password to continue</p>
    ${error ? `<div class="error">${error}</div>` : ""}
    <form method="POST" action="/login">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required autofocus />
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>`;
}
