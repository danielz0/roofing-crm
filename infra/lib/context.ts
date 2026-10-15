import type { Construct } from "constructs";

/** Deploy-time configuration, read from `cdk.json` context or `-c key=value`. All optional. */
export type DeployContext = {
  projectName: string;
  /** CRM_DATA_BASE_URL for the Lambda, e.g. https://ipfs.io/ipfs/<rootCid> or https://<gateway>/ipfs/<cid>. */
  dataBaseUrl?: string;
  dataMode: "view" | "materialize";
  llmProvider: "bedrock" | "anthropic" | "openai" | "none";
  llmModelId?: string;
  embeddings?: "none" | "bedrock-titan";
  roofAgeThresholdYears?: string;
  longOpenPermitDays?: string;
  lambdaMemoryMb: number;
  provisionedConcurrency?: number;
  alarmEmail?: string;
  /** PagerDuty CloudWatch integration endpoint subscribed to the alarm topic. */
  pagerDutyEndpoint?: string;
  /** Optional existing API Gateway custom domain + base path (mapping key). */
  apiDomainName?: string;
  apiBasePath?: string;
  corsOrigins?: string[];
  retainData: boolean;
};

export function readContext(scope: Construct): DeployContext {
  const get = (k: string): unknown => scope.node.tryGetContext(k);
  const str = (k: string): string | undefined => {
    const v = get(k);
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };
  const num = (k: string): number | undefined => {
    const v = get(k);
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    return Number.isFinite(n) ? n : undefined;
  };
  const mode = str("dataMode");
  const provider = str("llmProvider");
  const cors = str("corsOrigins");
  return {
    projectName: str("projectName") ?? "roofing-crm",
    dataBaseUrl: str("dataBaseUrl"),
    dataMode: mode === "materialize" ? "materialize" : "view",
    llmProvider:
      provider === "anthropic" || provider === "openai" || provider === "none" ? provider : "bedrock",
    llmModelId: str("llmModelId"),
    embeddings: str("embeddings") === "bedrock-titan" ? "bedrock-titan" : "none",
    roofAgeThresholdYears: str("roofAgeThresholdYears"),
    longOpenPermitDays: str("longOpenPermitDays"),
    lambdaMemoryMb: num("lambdaMemoryMb") ?? 3008,
    provisionedConcurrency: num("provisionedConcurrency"),
    alarmEmail: str("alarmEmail"),
    pagerDutyEndpoint: str("pagerDutyEndpoint"),
    apiDomainName: str("apiDomainName"),
    apiBasePath: str("apiBasePath"),
    corsOrigins: cors ? cors.split(",").map((s) => s.trim()) : undefined,
    retainData: str("retainData") !== "false",
  };
}
