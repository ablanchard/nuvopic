import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { handler } from "./index.js";
import { logger } from "./logger.js";
import api from "./api/router.js";
import {
  authMiddleware,
  isAuthEnabled,
  handleLoginPage,
  handleLogin,
  handleLogout,
} from "./auth/handlers.js";

const PORT = parseInt(process.env.PORT || "8080", 10);

const app = new Hono();

// Health check endpoint (always public)
app.get("/health", (c) => c.json({ status: "ok" }));

// Auth routes (public)
app.get("/login", handleLoginPage);
app.post("/login", handleLogin);
app.post("/logout", handleLogout);

// S3 webhook endpoint (public — called by MinIO/S3 notifications)
// Optionally secured via WEBHOOK_SECRET env var (passed as ?token= query param)
app.post("/webhook/s3", async (c) => {
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (webhookSecret) {
    const token = c.req.query("token");
    if (token !== webhookSecret) {
      return c.json({ error: "Unauthorized" }, 401);
    }
  }

  try {
    const event = await c.req.json();
    logger.info(`Webhook received: ${JSON.stringify(event).slice(0, 200)}`);

    // MinIO sends { EventName, Key, Records } — normalize to S3 event format
    const s3Event = event.Records ? event : { Records: event.Records };

    // Process asynchronously — return 200 immediately
    handler(s3Event).then((result) => {
      const body = JSON.parse(result.body);
      logger.info(`Webhook processing complete: ${body.processed} photos processed`);
    }).catch((error) => {
      logger.error("Webhook processing error:", error);
    });

    return c.json({ status: "accepted" }, 202);
  } catch (error) {
    logger.error("Webhook error:", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      500
    );
  }
});

// Auth middleware - protects everything below
app.use("*", authMiddleware);

// Mount API routes
app.route("/api/v1", api);

// Process endpoint (existing Lambda-style handler)
app.post("/process", async (c) => {
  try {
    const event = await c.req.json();
    const result = await handler(event);
    return c.json(JSON.parse(result.body), result.statusCode as 200 | 400 | 500);
  } catch (error) {
    logger.error("Error processing request:", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      500
    );
  }
});

// Serve static files from webapp/dist in production
app.use("/*", serveStatic({ root: "./webapp/dist" }));

// Fallback to index.html for SPA routing
app.get("*", serveStatic({ path: "./webapp/dist/index.html" }));

serve({ fetch: app.fetch, port: PORT }, () => {
  logger.info(`Server listening on port ${PORT}`);
  logger.info(`Auth: ${isAuthEnabled() ? "enabled" : "disabled (no AUTH_PASSWORD set)"}`);
  logger.info(`Health check: http://localhost:${PORT}/health`);
  logger.info(`API: http://localhost:${PORT}/api/v1`);
  logger.info(`Process endpoint: http://localhost:${PORT}/process`);
});
