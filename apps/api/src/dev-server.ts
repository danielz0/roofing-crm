import { createServer } from "node:http";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { loadConfig } from "./config.js";
import { logger } from "./observability.js";
import { appRouter } from "./routers/index.js";
import { getServices } from "./services.js";

/** Local development server: same router as the Lambda, served at http://localhost:<port>/trpc. */
const SIBLING_PIPELINE_EXPORTS = "../oracle-property-intelligence-platform-pipeline-travis-tx/data/exports";
if (!process.env.CRM_DATA_BASE_URL) {
  // Dev convenience only (never in Lambda): read the sibling pipeline checkout's latest export.
  process.env.CRM_DATA_BASE_URL = SIBLING_PIPELINE_EXPORTS;
  logger.warn("CRM_DATA_BASE_URL not set; using the sibling pipeline exports directory", {
    path: SIBLING_PIPELINE_EXPORTS,
  });
}
const config = loadConfig();
const trpc = createHTTPHandler({
  router: appRouter,
  basePath: "/trpc/",
  createContext: () => ({ getServices, requestId: `local-${Date.now().toString(36)}` }),
  onError: ({ error, path }) => {
    if (error.code === "INTERNAL_SERVER_ERROR") logger.error("trpc_internal_error", { path, error });
  },
});

const server = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", config.CRM_CORS_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type,authorization,trpc-accept");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    return;
  }
  if (!req.url?.startsWith("/trpc/")) {
    res.writeHead(404).end();
    return;
  }
  trpc(req, res);
});

server.listen(config.CRM_API_PORT, () => {
  logger.info("api_listening", { url: `http://localhost:${config.CRM_API_PORT}/trpc` });
  // Warm the snapshot so the first UI request is fast.
  getServices().catch((err: unknown) => logger.error("services_init_failed", { error: String(err) }));
});
