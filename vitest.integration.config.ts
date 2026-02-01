import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/e2e/**/*.test.ts"],
    testTimeout: 120000, // 2 minutes for model loading
    setupFiles: ["tests/e2e/setup.ts"],
    pool: "forks", // Use forks to avoid memory issues with models
    poolOptions: {
      forks: {
        singleFork: true, // Run tests sequentially to share model loading
      },
    },
    env: {
      LOG_LEVEL: "error", // Only show errors during tests
    },
  },
});
