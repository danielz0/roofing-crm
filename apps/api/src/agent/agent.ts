import { stepCountIs, tool, ToolLoopAgent, type EmbeddingModel, type LanguageModel } from "ai";
import { z } from "zod";
import {
  MAX_RADIUS_MILES,
  type AgentAnswer,
  type AgentAskInput,
  type Citation,
  type GeoPoint,
} from "@roofing-crm/shared";
import type { SnapshotStore } from "../data/snapshot.js";
import {
  EvidenceCollector,
  geocodePlace,
  getPropertyDetails,
  searchLeadProperties,
  searchPermitText,
  searchRoofingPermits,
  snapshotSummary,
  type RetrievalDeps,
} from "./retrieval.js";
import { planQuestion } from "./planner.js";

export type AgentDefaults = RetrievalDeps["defaults"];

export type RoofingAgentOptions = {
  store: SnapshotStore;
  model: LanguageModel | null;
  modelLabel: string;
  embeddingModel?: EmbeddingModel | null;
  defaults: AgentDefaults;
  maxSteps: number;
  strictTools?: boolean;
  /** Hard client timeout for the whole LLM tool loop (must stay below the API Gateway 30 s limit). */
  llmTimeoutMs?: number;
  onLlmError?: (error: unknown) => void;
};

export const AGENT_INSTRUCTIONS = `You are the research assistant inside a roofing-lead CRM for a single county.
You answer questions about roofing opportunities using ONLY the tools provided, which query a read-only
property/permit snapshot exported by a data pipeline.

How to work:
- If the user names a city/place, call geocode_place first and use the returned latitude/longitude as the search center.
- If the user gives no place, use the map center supplied in the question context.
- Convert durations to days for permits (1 year = 365 days) and to years for roof age.
- Open-permit questions -> search_roofing_permits. Aged-roof questions -> search_lead_properties.
- Questions about a contractor, a type of work or wording in permit descriptions -> search_permit_text.
- Call get_property_details only for a few properties the user asks about specifically.

How to answer:
- Be concise. Lead with the count of matches, then list the top results (max 10) as bullets.
- Cite every permit by its permit number (e.g. 2012-012345 RS) and every property by "prop <prop_id>".
- Never invent permit numbers, prop ids, contractor names, ratings or URLs: only use values returned by tools.
- State assumptions you made (place resolution, thresholds, radius) and missing data (e.g. BBB ratings
  unavailable, roof age inferred from year built) in a short "Assumptions & gaps" section.
- If the tools return nothing, say so and suggest how to widen the search.`;

const coordinate = {
  lat: z.number().min(-90).max(90).describe("Search center latitude"),
  lng: z.number().min(-180).max(180).describe("Search center longitude"),
};

export function buildTools(deps: RetrievalDeps, strict: boolean) {
  return {
    geocode_place: tool({
      description:
        "Resolve a city / town / CDP name in the county area to coordinates using Census place centroids. Returns candidates best-first.",
      inputSchema: z.object({ place: z.string().min(2).describe("Place name, e.g. 'Pflugerville'") }),
      strict,
      execute: async ({ place }) => geocodePlace(deps, place),
    }),
    search_roofing_permits: tool({
      description:
        "Find roofing permits within a radius, sorted by how long they have been open (longest first). Use minOpenDays for 'open longer than N years' (N*365).",
      inputSchema: z.object({
        ...coordinate,
        radiusMiles: z.number().positive().max(MAX_RADIUS_MILES).describe("Radius in miles"),
        minOpenDays: z.number().int().min(0).describe("Minimum days open; 0 for any"),
        openOnly: z.boolean().describe("true = only permits still open"),
        statuses: z.array(z.string()).describe("Exact permit statuses to include; empty for any"),
        limit: z.number().int().min(1).max(100).describe("Max rows, default 25"),
      }),
      strict,
      execute: async (input) => searchRoofingPermits(deps, input),
    }),
    search_lead_properties: tool({
      description:
        "Find properties within a radius that are roofing leads: aged roofs (roof age >= minRoofAgeYears) and/or open roofing permits. Sorted by lead priority.",
      inputSchema: z.object({
        ...coordinate,
        radiusMiles: z.number().positive().max(MAX_RADIUS_MILES),
        minRoofAgeYears: z.number().int().min(0).max(200).describe("Roof age threshold in years"),
        minOpenDays: z.number().int().min(0).describe("Minimum open days for the open-permit signal"),
        matchMode: z.enum(["either", "aged_roof", "open_permit", "both"]),
        limit: z.number().int().min(1).max(100),
      }),
      strict,
      execute: async (input) => searchLeadProperties(deps, input),
    }),
    search_permit_text: tool({
      description:
        "Full-text (BM25) search over roofing permit descriptions, contractor names, addresses and permit classes. Optionally restricted to a radius and/or open permits.",
      inputSchema: z.object({
        query: z.string().min(2).describe("Keywords, e.g. a contractor name or 'reroof tear off'"),
        lat: z
          .number()
          .min(-90)
          .max(90)
          .nullable()
          .describe("Optional center latitude, null for county-wide"),
        lng: z
          .number()
          .min(-180)
          .max(180)
          .nullable()
          .describe("Optional center longitude, null for county-wide"),
        radiusMiles: z.number().positive().max(MAX_RADIUS_MILES).nullable(),
        openOnly: z.boolean(),
        limit: z.number().int().min(1).max(50),
      }),
      strict,
      execute: async ({ lat, lng, radiusMiles, ...rest }) =>
        searchPermitText(deps, {
          ...rest,
          lat: lat ?? undefined,
          lng: lng ?? undefined,
          radiusMiles: radiusMiles ?? undefined,
        }),
    }),
    get_property_details: tool({
      description: "Get one property's owner/mailing info, roof-age evidence and all of its roofing permits.",
      inputSchema: z.object({ propId: z.string().min(1) }),
      strict,
      execute: async ({ propId }) => getPropertyDetails(deps, propId),
    }),
    get_snapshot_info: tool({
      description: "Snapshot run id, as-of date, table row counts and known data limitations.",
      inputSchema: z.object({}),
      strict,
      execute: async () => snapshotSummary(deps),
    }),
  };
}

export class RoofingAgent {
  constructor(private readonly opts: RoofingAgentOptions) {}

  get mode(): "llm" | "retrieval_only" {
    return this.opts.model ? "llm" : "retrieval_only";
  }

  async ask(input: AgentAskInput): Promise<AgentAnswer> {
    const evidence = new EvidenceCollector();
    const center: GeoPoint = input.center ?? this.opts.defaults.center;
    const deps: RetrievalDeps = {
      store: this.opts.store,
      evidence,
      defaults: {
        ...this.opts.defaults,
        center,
        radiusMiles: input.radiusMiles ?? this.opts.defaults.radiusMiles,
      },
      embeddingModel: this.opts.embeddingModel ?? null,
    };

    if (this.opts.model) {
      try {
        return await this.askLlm(input, deps, center);
      } catch (error) {
        // Synchronous external call: on timeout/failure degrade to deterministic retrieval instead of failing.
        this.opts.onLlmError?.(error);
        const fallback = new EvidenceCollector();
        const answer = await planQuestion({ ...deps, evidence: fallback }, input.question);
        fallback.missingData.add(
          `LLM unavailable (${error instanceof Error ? error.name : "error"}); answered in retrieval-only mode.`,
        );
        return assembleAnswer(answer, fallback, this.opts.store, "retrieval-only (LLM fallback)");
      }
    }
    const answer = await planQuestion(deps, input.question);
    return assembleAnswer(answer, evidence, this.opts.store, this.opts.modelLabel);
  }

  private async askLlm(input: AgentAskInput, deps: RetrievalDeps, center: GeoPoint): Promise<AgentAnswer> {
    if (!this.opts.model) throw new Error("No LLM configured");
    // The agent is built per request because its tools close over this request's evidence collector.
    const agent = new ToolLoopAgent({
      model: this.opts.model,
      instructions: AGENT_INSTRUCTIONS,
      tools: buildTools(deps, this.opts.strictTools ?? false),
      stopWhen: stepCountIs(this.opts.maxSteps),
    });
    const context = `Map context: center lat=${center.lat.toFixed(5)}, lng=${center.lng.toFixed(5)}, radius=${deps.defaults.radiusMiles} miles. Default roof-age threshold ${this.opts.defaults.roofAgeThresholdYears} years. Snapshot run ${this.opts.store.info.runId ?? "unknown"}, as of ${this.opts.store.info.asOfDate ?? "unknown"}.`;
    const result = await agent.generate({
      prompt: `${context}\n\nQuestion: ${input.question}`,
      abortSignal: AbortSignal.timeout(this.opts.llmTimeoutMs ?? 25_000),
    });
    const answer = result.text.trim() || "The model returned no text. See the retrieved results below.";
    return assembleAnswer(answer, deps.evidence, this.opts.store, this.opts.modelLabel);
  }
}

/** Build the structured answer: validated citations, assumptions, gaps and the full result rows. */
export function assembleAnswer(
  answer: string,
  evidence: EvidenceCollector,
  store: SnapshotStore,
  model: string,
): AgentAnswer {
  const citations: Citation[] = [];
  for (const [id, p] of evidence.permits) {
    if (answer.includes(id)) citations.push({ kind: "permit", id, url: p.permit_link ?? p.source_url });
  }
  for (const [id, p] of evidence.properties) {
    if (new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(answer)) {
      citations.push({ kind: "property", id, url: p.parcel_source_url });
    }
  }
  citations.push({
    kind: "source",
    id: `snapshot ${store.info.runId ?? "unknown"}`,
    url: store.info.baseUrl.startsWith("http") ? store.info.baseUrl : null,
  });

  const permits = [...evidence.permits.values()]
    .sort((a, b) => (b.open_days ?? -1) - (a.open_days ?? -1))
    .slice(0, 100);
  const properties = [...evidence.properties.values()].slice(0, 100);
  return {
    answer,
    citations,
    assumptions: [...evidence.assumptions],
    missingData: [...evidence.missingData],
    permits,
    properties,
    toolCalls: evidence.toolCalls,
    model,
  };
}
