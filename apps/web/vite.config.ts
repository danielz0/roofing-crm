import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // Read VITE_* variables from the repo-root .env shared with the API.
  envDir: "../..",
  server: { port: 5173 },
  build: { sourcemap: true, chunkSizeWarningLimit: 1500 },
  test: { environment: "jsdom", setupFiles: ["test/setup.ts"] },
});
