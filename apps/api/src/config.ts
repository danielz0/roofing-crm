import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  DEFAULT_COUNTY,
  DEFAULT_LONG_OPEN_PERMIT_DAYS,
  DEFAULT_RADIUS_MILES,
  DEFAULT_ROOF_AGE_THRESHOLD_YEARS,
} from "@roofing-crm/shared";

const boolish = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const envSchema = z.object({
  /** Snapshot root: local directory (absolute or relative to the repo root) or https URL (e.g. IPFS gateway). */
  CRM_DATA_BASE_URL: z.string().min(1).optional(),
  /** materialize = copy tables into in-memory DuckDB at startup; view = query parquet in place. */
  CRM_DATA_MODE: z.enum(["materialize", "view"]).default("materialize"),
  /** Tables always materialized regardless of mode (needed for FTS and small lookups). */
  CRM_DUCKDB_EXTENSION_DIR: z.string().optional(),
  CRM_DUCKDB_MEMORY_LIMIT: z.string().optional(),
  CRM_DUCKDB_THREADS: z.coerce.number().int().positive().optional(),
  /** When true, never INSTALL extensions from the network (Lambda uses pre-bundled extensions). */
  CRM_DUCKDB_OFFLINE: boolish,

  CRM_COUNTY_NAME: z.string().default(DEFAULT_COUNTY.name),
  CRM_COUNTY_STATE: z.string().default(DEFAULT_COUNTY.state),
  CRM_COUNTY_FIPS: z.string().default(DEFAULT_COUNTY.fips),
  CRM_DEFAULT_CENTER_LAT: z.coerce.number().default(DEFAULT_COUNTY.center.lat),
  CRM_DEFAULT_CENTER_LNG: z.coerce.number().default(DEFAULT_COUNTY.center.lng),
  CRM_DEFAULT_RADIUS_MILES: z.coerce.number().positive().default(DEFAULT_RADIUS_MILES),
  CRM_ROOF_AGE_THRESHOLD_YEARS: z.coerce.number().int().positive().default(DEFAULT_ROOF_AGE_THRESHOLD_YEARS),
  CRM_LONG_OPEN_PERMIT_DAYS: z.coerce.number().int().positive().default(DEFAULT_LONG_OPEN_PERMIT_DAYS),

  CRM_LEADS_STORE: z.enum(["memory", "file", "dynamodb"]).default("file"),
  CRM_LEADS_FILE: z.string().default(".data/leads.json"),
  CRM_LEADS_TABLE: z.string().optional(),

  CRM_API_PORT: z.coerce.number().int().positive().default(4000),
  CRM_CORS_ORIGIN: z.string().default("*"),

  LLM_PROVIDER: z.enum(["bedrock", "anthropic", "openai", "none"]).default("bedrock"),
  LLM_MODEL_ID: z.string().optional(),
  LLM_REGION: z.string().default("us-east-2"),
  LLM_MAX_STEPS: z.coerce.number().int().positive().default(8),
  /** Client timeout for the whole agent loop; keep below the 30 s API Gateway integration timeout. */
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(25_000),
  /** Optional semantic rerank of BM25 hits with Bedrock Titan text embeddings. */
  CRM_EMBEDDINGS: z.enum(["none", "bedrock-titan"]).default("none"),
  CRM_EMBEDDING_MODEL_ID: z.string().default("amazon.titan-embed-text-v2:0"),
});

export type AppEnv = z.infer<typeof envSchema>;

export const DEFAULT_MODEL_IDS: Record<Exclude<AppEnv["LLM_PROVIDER"], "none">, string> = {
  // Must be an inference profile enabled in the target account/region (see SOLUTION.md open questions).
  bedrock: "us.anthropic.claude-opus-5-5",
  anthropic: "claude-opus-5-5",
  // No default is assumed for OpenAI beyond a placeholder; set LLM_MODEL_ID explicitly.
  openai: "gpt-5-mini",
};

export type AppConfigResolved = AppEnv & {
  repoRoot: string;
  llmModelId: string | null;
};

export function findRepoRoot(start: string = process.cwd()): string {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfigResolved {
  const parsed = envSchema.parse(env);
  const llmModelId =
    parsed.LLM_PROVIDER === "none" ? null : (parsed.LLM_MODEL_ID ?? DEFAULT_MODEL_IDS[parsed.LLM_PROVIDER]);
  return { ...parsed, repoRoot: findRepoRoot(), llmModelId };
}
