import { loadConfig } from "../src/config.js";
import { createServices, type Services } from "../src/services.js";
import type { LeadRepository } from "../src/leads/repository.js";
import { appRouter } from "../src/routers/index.js";
import { createCallerFactory } from "../src/trpc.js";
import { createSyntheticSnapshot } from "./fixtures/synthetic-snapshot.js";

let fixtureDir: Promise<string> | null = null;
export function fixtureSnapshot(): Promise<string> {
  fixtureDir ??= createSyntheticSnapshot();
  return fixtureDir;
}

export async function testServices(overrides: { leadRepository?: LeadRepository } = {}): Promise<Services> {
  const dir = await fixtureSnapshot();
  const config = loadConfig({ CRM_DATA_BASE_URL: dir, CRM_LEADS_STORE: "memory", LLM_PROVIDER: "none" });
  return createServices(config, overrides);
}

export async function testCaller(overrides: { leadRepository?: LeadRepository } = {}) {
  const services = await testServices(overrides);
  const caller = createCallerFactory(appRouter)({ getServices: async () => services, requestId: "test" });
  return { caller, services };
}
