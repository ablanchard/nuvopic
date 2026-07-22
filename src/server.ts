import "dotenv/config";
import { Hono } from "hono";
import type { Context } from "hono";
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
import { getDeployMode, isManagedMode } from "./config/runtime.js";
import { getSetting } from "./db/settings.js";
import { runWithWorkspaceContext } from "./db/client.js";

const PORT = parseInt(process.env.PORT || "8080", 10);

interface NormalizedS3EventRecord {
  s3: {
    bucket: {
      name: string;
    };
    object: {
      key: string;
    };
  };
}

interface NormalizedS3Event {
  Records: NormalizedS3EventRecord[];
}

function normalizeS3Event(event: unknown): NormalizedS3Event {
  if (
    typeof event === "object" &&
    event !== null &&
    "Records" in event &&
    Array.isArray((event as { Records?: unknown[] }).Records)
  ) {
    return event as NormalizedS3Event;
  }

  if (Array.isArray(event)) {
    return { Records: event as NormalizedS3EventRecord[] };
  }

  if (
    typeof event === "object" &&
    event !== null &&
    "s3" in event
  ) {
    return { Records: [event as NormalizedS3EventRecord] };
  }

  throw new Error("Unsupported webhook payload");
}

function getWebhookToken(c: Context): string | null {
  return c.req.query("token") ?? c.req.header("x-nuvopic-webhook-secret") ?? null;
}

async function processWebhookEvent(
  c: Context,
  event: unknown
): Promise<Response> {
  const s3Event = normalizeS3Event(event);

  handler(s3Event)
    .then((result) => {
      const body = JSON.parse(result.body);
      logger.info(`Webhook processing complete: ${body.processed} photos processed`);
    })
    .catch((error) => {
      logger.error("Webhook processing error:", error);
    });

  return c.json({ status: "accepted" }, 202);
}

const app = new Hono();

app.get("/health", (c) => c.json({ status: "ok", mode: getDeployMode() }));

app.get("/login", handleLoginPage);
app.post("/login", handleLogin);
app.post("/logout", handleLogout);

app.post("/webhook/s3", async (c) => {
  if (isManagedMode()) {
    return c.json({ error: "Managed mode requires a workspace-scoped webhook URL" }, 400);
  }

  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (webhookSecret && getWebhookToken(c) !== webhookSecret) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const event = await c.req.json();
    logger.info(`Webhook received: ${JSON.stringify(event).slice(0, 200)}`);
    return await processWebhookEvent(c, event);
  } catch (error) {
    logger.error("Webhook error:", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      500
    );
  }
});

app.post("/webhook/s3/:workspaceId", async (c) => {
  if (!isManagedMode()) {
    return c.json({ error: "Workspace webhook URLs are only available in managed mode" }, 400);
  }

  const workspaceId = c.req.param("workspaceId");

  try {
    return await runWithWorkspaceContext(workspaceId, async () => {
      const webhookSecret = await getSetting("webhook_secret");
      if (webhookSecret && getWebhookToken(c) !== webhookSecret) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const event = await c.req.json();
      logger.info(
        `Managed webhook received for workspace=${workspaceId}: ${JSON.stringify(event).slice(0, 200)}`
      );
      return await processWebhookEvent(c, event);
    });
  } catch (error) {
    logger.error("Managed webhook error:", error);
    return c.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      500
    );
  }
});

app.use("*", authMiddleware);

app.route("/api/v1", api);

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

app.use("/*", serveStatic({ root: "./webapp/dist" }));
app.get("*", serveStatic({ path: "./webapp/dist/index.html" }));

serve({ fetch: app.fetch, port: PORT }, () => {
  logger.info(`Server listening on port ${PORT}`);
  logger.info(`Deploy mode: ${getDeployMode()}`);
  logger.info(
    `Auth: ${
      isManagedMode()
        ? "managed JWT"
        : isAuthEnabled()
          ? "enabled"
          : "disabled (no AUTH_PASSWORD set)"
    }`
  );
  logger.info(`Health check: http://localhost:${PORT}/health`);
  logger.info(`API: http://localhost:${PORT}/api/v1`);
  logger.info(`Process endpoint: http://localhost:${PORT}/process`);
});
