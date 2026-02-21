import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createToken, verifyToken } from "./jwt.js";
import { logger } from "../logger.js";

const COOKIE_NAME = "session";
const LOGIN_PATH = "/login";
const SESSION_DURATION = 86400 * 7; // 7 days

/**
 * Public paths that don't require authentication.
 */
const PUBLIC_PATHS = ["/health", LOGIN_PATH];

function getPassword(): string {
  const password = process.env.AUTH_PASSWORD;
  if (!password) {
    throw new Error("AUTH_PASSWORD environment variable is required");
  }
  return password;
}

/**
 * Returns true if auth is enabled (AUTH_PASSWORD is set).
 */
export function isAuthEnabled(): boolean {
  return !!process.env.AUTH_PASSWORD;
}

/**
 * Auth middleware. Checks the session cookie for a valid JWT.
 * If AUTH_PASSWORD is not set, auth is disabled (pass-through).
 */
export async function authMiddleware(c: Context, next: Next) {
  // If auth is not configured, skip
  if (!isAuthEnabled()) {
    return next();
  }

  const path = new URL(c.req.url).pathname;

  // Allow public paths
  if (PUBLIC_PATHS.some((p) => path === p)) {
    return next();
  }

  // Check session cookie
  const token = getCookie(c, COOKIE_NAME);
  if (token) {
    const payload = verifyToken(token);
    if (payload) {
      return next();
    }
  }

  // For API requests, return 401 JSON
  if (path.startsWith("/api/")) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // For browser requests, redirect to login
  return c.redirect(LOGIN_PATH);
}

/**
 * Handle GET /login - serve the login page.
 */
export function handleLoginPage(c: Context) {
  // If already authenticated, redirect to home
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
  if (!isAuthEnabled()) {
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
