import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "../logger.js";
import photos from "./routes/photos.js";
import persons from "./routes/persons.js";
import tags from "./routes/tags.js";
import clusters from "./routes/clusters.js";

const api = new Hono();

// CORS middleware
api.use("/*", cors());

// Error handling
api.onError((err, c) => {
  logger.error("API error:", err);
  return c.json({ error: err.message }, 500);
});

// Mount routes
api.route("/photos", photos);
api.route("/persons", persons);
api.route("/tags", tags);
api.route("/clusters", clusters);

export default api;
