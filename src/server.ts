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
import { closePool, runWithWorkspaceContext } from "./db/client.js";
import {
  enqueueS3WebhookJob,
  processPendingJobsInCurrentWorkspace,
  startProcessingJobWorker,
  stopProcessingJobWorker,
} from "./jobs/processing-jobs.js";

const PORT = parseInt(process.env.PORT || "8080", 10);
const SHUTDOWN_TIMEOUT_MS = parseInt(
  process.env.SHUTDOWN_TIMEOUT_MS || "30000",
  10
);
const activeBackgroundJobs = new Set<Promise<void>>();
let isShuttingDown = false;

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

  const job = handler(s3Event)
    .then((result) => {
      const body = JSON.parse(result.body);
      logger.info(`Webhook processing complete: ${body.processed} photos processed`);
    })
    .catch((error) => {
      logger.error("Webhook processing error:", error);
    });
  activeBackgroundJobs.add(job);
  void job.finally(() => activeBackgroundJobs.delete(job));

  return c.json({ status: "accepted" }, 202);
}

async function queueManagedWebhookEvent(c: Context, event: unknown): Promise<Response> {
  // Validate the shape before committing an accepted job to the durable queue.
  normalizeS3Event(event);
  const jobId = await enqueueS3WebhookJob(event);
  const job = processPendingJobsInCurrentWorkspace(1).catch((error) => {
    logger.error(`Immediate processing-job run failed after enqueueing ${jobId}:`, error);
  });
  activeBackgroundJobs.add(job);
  void job.finally(() => activeBackgroundJobs.delete(job));
  return c.json({ status: "accepted", jobId }, 202);
}

const app = new Hono();

app.get("/health", (c) =>
  c.json(
    {
      status: isShuttingDown ? "shutting_down" : "ok",
      mode: getDeployMode(),
    },
    isShuttingDown ? 503 : 200
  )
);

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
      return await queueManagedWebhookEvent(c, event);
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
    return c.json(JSON.parse(result.body), result.statusCode as 200 | 400 | 402 | 500);
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

const server = serve({ fetch: app.fetch, port: PORT }, () => {
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
  startProcessingJobWorker();
});

function closeServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (isShuttingDown) {
    logger.warn(`Received ${signal} while shutdown is already in progress`);
    return;
  }

  isShuttingDown = true;
  logger.info(`Received ${signal}; beginning graceful shutdown`);

  const forceExitTimer = setTimeout(() => {
    logger.error(
      `Graceful shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms; forcing exit`
    );
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExitTimer.unref();

  try {
    await closeServer();
    await stopProcessingJobWorker();

    if (activeBackgroundJobs.size > 0) {
      logger.info(
        `Waiting for ${activeBackgroundJobs.size} background job(s) to finish`
      );
      await Promise.allSettled([...activeBackgroundJobs]);
    }

    await closePool();
    clearTimeout(forceExitTimer);
    logger.info("Graceful shutdown complete");
    process.exit(0);
  } catch (error) {
    clearTimeout(forceExitTimer);
    logger.error("Graceful shutdown failed:", error);
    process.exit(1);
  }
}

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
