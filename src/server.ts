import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { handler } from "./index.js";
import { logger } from "./logger.js";
import api from "./api/router.js";

const PORT = parseInt(process.env.PORT || "8080", 10);

const app = new Hono();

// Health check endpoint
app.get("/health", (c) => c.json({ status: "ok" }));

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
  logger.info(`Health check: http://localhost:${PORT}/health`);
  logger.info(`API: http://localhost:${PORT}/api/v1`);
  logger.info(`Process endpoint: http://localhost:${PORT}/process`);
});
