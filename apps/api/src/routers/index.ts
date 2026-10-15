import { router } from "../trpc.js";
import { agentRouter } from "./agent.js";
import { contractorsRouter } from "./contractors.js";
import { leadsRouter } from "./leads.js";
import { metaRouter } from "./meta.js";
import { permitsRouter } from "./permits.js";
import { propertiesRouter } from "./properties.js";

export const appRouter = router({
  meta: metaRouter,
  properties: propertiesRouter,
  permits: permitsRouter,
  contractors: contractorsRouter,
  leads: leadsRouter,
  agent: agentRouter,
});

export type AppRouter = typeof appRouter;
