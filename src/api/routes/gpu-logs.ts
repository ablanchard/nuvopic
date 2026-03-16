import { Hono } from "hono";
import { getGpuLogs, getGpuLogById, getGpuLogChildren, type GpuLogRow } from "../../db/gpu-logs.js";

const gpuLogs = new Hono();

// GET /api/v1/gpu-logs — list job-level GPU logs (paginated, filterable)
gpuLogs.get("/", async (c) => {
  const page = parseInt(c.req.query("page") ?? "1", 10);
  const limit = parseInt(c.req.query("limit") ?? "50", 10);
  const type = c.req.query("type") || undefined;
  const status = c.req.query("status") || undefined;

  const { logs, total } = await getGpuLogs({
    jobsOnly: true,
    type,
    status,
    page,
    limit,
  });

  return c.json({
    logs: logs.map(formatLog),
    pagination: {
      page,
      limit,
      total,
      hasMore: page * limit < total,
    },
  });
});

// GET /api/v1/gpu-logs/:id — get a single GPU log with its children
gpuLogs.get("/:id", async (c) => {
  const id = c.req.param("id");
  const log = await getGpuLogById(id);

  if (!log) {
    return c.json({ error: "GPU log not found" }, 404);
  }

  const children = await getGpuLogChildren(id);

  return c.json({
    log: formatLog(log),
    children: children.map(formatLog),
  });
});

// GET /api/v1/gpu-logs/:id/children — get children of a job log (paginated)
gpuLogs.get("/:id/children", async (c) => {
  const id = c.req.param("id");
  const children = await getGpuLogChildren(id);

  return c.json({
    children: children.map(formatLog),
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatLog(row: GpuLogRow) {
  return {
    id: row.id,
    parentId: row.parent_id,
    type: row.type,
    provider: row.provider,
    gpuMode: row.gpu_mode,
    photoId: row.photo_id,
    s3Path: row.s3_path,
    status: row.status,
    photoCount: row.photo_count,
    photosSucceeded: row.photos_succeeded,
    photosFailed: row.photos_failed,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
    error: row.error,
    childrenCount: row.children_count ?? 0,
  };
}

export default gpuLogs;
