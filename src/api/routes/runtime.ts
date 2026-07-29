import { Hono } from "hono";
import {
  getDeployMode,
  getManagedAdminPath,
  getManagedProfilePath,
  getManagedTokenEndpoint,
  isManagedMode,
} from "../../config/runtime.js";
import { getAuthInfo } from "../../auth/handlers.js";
import { isS3Configured } from "../../db/settings.js";

const runtime = new Hono();

runtime.get("/", (c) => {
  const deployMode = getDeployMode();

  return c.json({
    deployMode,
    managedTokenEndpoint: isManagedMode() ? getManagedTokenEndpoint() : null,
    profilePath: isManagedMode() ? getManagedProfilePath() : null,
    adminPath: isManagedMode() ? getManagedAdminPath() : null,
    storageSetupPath: "/app/setup/storage",
  });
});

runtime.get("/session", async (c) => {
  const auth = getAuthInfo(c);
  const storageConfigured = await isS3Configured();

  return c.json({
    deployMode: getDeployMode(),
    role: auth.role,
    subject: auth.subject,
    workspaceId: auth.workspaceId,
    storageConfigured,
    storageSetupPath: "/app/setup/storage",
    profilePath: isManagedMode() ? getManagedProfilePath() : null,
    adminPath: isManagedMode() ? getManagedAdminPath() : null,
  });
});

export default runtime;
