import path from "node:path";
import { DEFAULT_COUNTY, type AppConfig } from "@roofing-crm/shared";
import { RoofingAgent } from "./agent/agent.js";
import { createChatModel, createEmbeddingModel } from "./agent/model.js";
import { loadConfig, type AppConfigResolved } from "./config.js";
import { SnapshotStore } from "./data/snapshot.js";
import { DynamoLeadRepository } from "./leads/dynamo.js";
import { FileLeadRepository } from "./leads/file.js";
import { InMemoryLeadRepository } from "./leads/memory.js";
import type { LeadRepository } from "./leads/repository.js";
import { LeadService } from "./leads/service.js";
import { logger } from "./observability.js";

export type Services = {
  config: AppConfigResolved;
  appConfig: AppConfig;
  store: SnapshotStore;
  leads: LeadService;
  agent: RoofingAgent;
  thresholds: { roofAgeThresholdYears: number; longOpenPermitDays: number };
};

async function createLeadRepository(config: AppConfigResolved): Promise<LeadRepository> {
  switch (config.CRM_LEADS_STORE) {
    case "memory":
      return new InMemoryLeadRepository();
    case "file":
      return FileLeadRepository.open(path.resolve(config.repoRoot, "apps/api", config.CRM_LEADS_FILE));
    case "dynamodb":
      if (!config.CRM_LEADS_TABLE)
        throw new Error("CRM_LEADS_TABLE is required when CRM_LEADS_STORE=dynamodb");
      return new DynamoLeadRepository(config.CRM_LEADS_TABLE);
  }
}

export async function createServices(
  config: AppConfigResolved,
  overrides: { leadRepository?: LeadRepository; store?: SnapshotStore; agent?: RoofingAgent } = {},
): Promise<Services> {
  if (!config.CRM_DATA_BASE_URL && !overrides.store) {
    throw new Error(
      "CRM_DATA_BASE_URL is not set. Point it at a pipeline export directory or an IPFS gateway URL.",
    );
  }
  const store =
    overrides.store ??
    (await SnapshotStore.open({
      baseUrl: config.CRM_DATA_BASE_URL ?? "",
      repoRoot: config.repoRoot,
      mode: config.CRM_DATA_MODE,
      extensionDir: config.CRM_DUCKDB_EXTENSION_DIR,
      memoryLimit: config.CRM_DUCKDB_MEMORY_LIMIT,
      threads: config.CRM_DUCKDB_THREADS,
      offline: config.CRM_DUCKDB_OFFLINE,
      log: (message, detail) => logger.info(message, detail ?? {}),
    }));
  const thresholds = {
    roofAgeThresholdYears: config.CRM_ROOF_AGE_THRESHOLD_YEARS,
    longOpenPermitDays: config.CRM_LONG_OPEN_PERMIT_DAYS,
  };
  const center = { lat: config.CRM_DEFAULT_CENTER_LAT, lng: config.CRM_DEFAULT_CENTER_LNG };
  const repo = overrides.leadRepository ?? (await createLeadRepository(config));
  const leads = new LeadService(
    repo,
    {
      getProperty: (id) => store.getProperty(id),
      permitsForProperty: (id) => store.permitsForProperty(id),
      runId: store.info.runId,
    },
    thresholds,
  );
  const model = createChatModel(config);
  const agent =
    overrides.agent ??
    new RoofingAgent({
      store,
      model,
      modelLabel: model ? `${config.LLM_PROVIDER}:${config.llmModelId}` : "retrieval-only",
      embeddingModel: createEmbeddingModel(config),
      defaults: { center, radiusMiles: config.CRM_DEFAULT_RADIUS_MILES, ...thresholds },
      maxSteps: config.LLM_MAX_STEPS,
      strictTools: false,
      llmTimeoutMs: config.LLM_TIMEOUT_MS,
      onLlmError: (error) => logger.error("llm_failed_fallback_to_retrieval", { error: String(error) }),
    });
  const appConfig: AppConfig = {
    county: {
      name: config.CRM_COUNTY_NAME,
      state: config.CRM_COUNTY_STATE,
      fips: config.CRM_COUNTY_FIPS,
      center,
      bounds: DEFAULT_COUNTY.bounds,
    },
    defaults: {
      radiusMiles: config.CRM_DEFAULT_RADIUS_MILES,
      roofAgeThresholdYears: thresholds.roofAgeThresholdYears,
      longOpenPermitDays: thresholds.longOpenPermitDays,
    },
    agentEnabled: true,
    llmProvider: model ? config.LLM_PROVIDER : "none (retrieval-only)",
  };
  logger.info("services_ready", {
    leadsStore: repo.kind,
    llm: appConfig.llmProvider,
    runId: store.info.runId,
  });
  return { config, appConfig, store, leads, agent, thresholds };
}

let servicesPromise: Promise<Services> | null = null;

/** Lazily create process-wide services (reused across Lambda invocations). */
export function getServices(): Promise<Services> {
  if (!servicesPromise) {
    servicesPromise = createServices(loadConfig()).catch((err: unknown) => {
      servicesPromise = null;
      throw err;
    });
  }
  return servicesPromise;
}
