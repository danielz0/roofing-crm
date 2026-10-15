import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: { POWERTOOLS_DEV: "true", POWERTOOLS_LOG_LEVEL: "ERROR", POWERTOOLS_METRICS_DISABLED: "true" },
  },
});
