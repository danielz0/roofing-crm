import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { RoofingAgent } from "../src/agent/agent.js";
import { applyBedrockPromptCaching } from "../src/agent/model.js";
import { parseQuestion } from "../src/agent/planner.js";
import { FIXTURE } from "./fixtures/synthetic-snapshot.js";
import { testServices } from "./helpers.js";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

type Step = { type: "tool"; name: string; input: unknown } | { type: "text"; text: string };

/** Mock model that plays a scripted sequence of tool calls, then a final answer. */
function scriptedModel(steps: Step[]) {
  let i = 0;
  const prompts: unknown[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(options.prompt);
      const step = steps[Math.min(i++, steps.length - 1)]!;
      if (step.type === "tool") {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: `call-${i}`,
              toolName: step.name,
              input: JSON.stringify(step.input),
            },
          ],
          finishReason: { unified: "tool-calls", raw: undefined },
          usage,
          warnings: [],
        };
      }
      return {
        content: [{ type: "text", text: step.text }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
  return { model, prompts };
}

describe("RAG agent with AI SDK mock model", () => {
  it("geocodes, retrieves long-open permits and cites only retrieved ids", async () => {
    const services = await testServices();
    const { model, prompts } = scriptedModel([
      { type: "tool", name: "geocode_place", input: { place: "Testville" } },
      {
        type: "tool",
        name: "search_roofing_permits",
        input: {
          ...FIXTURE.testville,
          radiusMiles: 5,
          minOpenDays: 1825,
          openOnly: true,
          statuses: [],
          limit: 25,
        },
      },
      {
        type: "text",
        text: "1 open roofing permit older than 5 years: D-OPEN at 600 TEST LN (prop P6). Also Z-FAKE.",
      },
    ]);
    const agent = new RoofingAgent({
      store: services.store,
      model,
      modelLabel: "mock",
      defaults: {
        center: FIXTURE.center,
        radiusMiles: 3,
        roofAgeThresholdYears: 15,
        longOpenPermitDays: 365,
      },
      maxSteps: 6,
    });
    const answer = await agent.ask({
      question: "show me open roofing permits older than five years within five miles of Testville",
    });

    expect(prompts).toHaveLength(3);
    expect(answer.permits.map((p) => p.permit_number)).toEqual(["D-OPEN"]);
    expect(answer.citations.filter((c) => c.kind === "permit")).toEqual([
      { kind: "permit", id: "D-OPEN", url: "https://example.test/permit/D" },
    ]);
    expect(answer.citations.some((c) => c.id === "Z-FAKE")).toBe(false);
    expect(answer.assumptions.join(" ")).toMatch(/Testville/);
    expect(answer.assumptions.join(" ")).toMatch(/1825 days/);
    expect(answer.missingData.join(" ")).toMatch(/BBB/);
    expect(answer.toolCalls.map((t) => t.tool)).toEqual(["geocode_place", "search_roofing_permits"]);
  });

  it("text retrieval tool returns BM25 hits", async () => {
    const services = await testServices();
    const { model } = scriptedModel([
      {
        type: "tool",
        name: "search_permit_text",
        input: { query: "tear off", lat: null, lng: null, radiusMiles: null, openOnly: false, limit: 5 },
      },
      { type: "text", text: "B-OPEN mentions a tear off." },
    ]);
    const agent = new RoofingAgent({
      store: services.store,
      model,
      modelLabel: "mock",
      defaults: {
        center: FIXTURE.center,
        radiusMiles: 3,
        roofAgeThresholdYears: 15,
        longOpenPermitDays: 365,
      },
      maxSteps: 4,
    });
    const answer = await agent.ask({ question: "which permits mention a tear off?" });
    expect(answer.citations[0]).toMatchObject({ kind: "permit", id: "B-OPEN" });
  });

  it("falls back to retrieval-only when the LLM fails", async () => {
    const services = await testServices();
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("ThrottlingException");
      },
    });
    const errors: unknown[] = [];
    const agent = new RoofingAgent({
      store: services.store,
      model,
      modelLabel: "mock",
      defaults: {
        center: FIXTURE.center,
        radiusMiles: 3,
        roofAgeThresholdYears: 15,
        longOpenPermitDays: 365,
      },
      maxSteps: 4,
      onLlmError: (e) => errors.push(e),
    });
    const answer = await agent.ask({ question: "open roofing permits within 5 miles of Testville" });
    expect(errors).toHaveLength(1);
    expect(answer.model).toBe("retrieval-only (LLM fallback)");
    expect(answer.permits.map((p) => p.permit_number)).toEqual(["D-OPEN"]);
    expect(answer.missingData.join(" ")).toMatch(/LLM unavailable/);
  });

  it("retrieval-only mode answers without an LLM", async () => {
    const services = await testServices();
    const answer = await services.agent.ask({
      question: "show me open roofing permits older than five years within five miles of Testville",
    });
    expect(answer.model).toBe("retrieval-only");
    expect(answer.permits.map((p) => p.permit_number)).toEqual(["D-OPEN"]);
    expect(answer.answer).toMatch(/D-OPEN/);
    expect(answer.citations.map((c) => c.id)).toContain("D-OPEN");
  });
});

describe("question planner", () => {
  it("parses the README example", () => {
    expect(
      parseQuestion("show me open roofing permits older than five years within five miles of Round Rock"),
    ).toMatchObject({
      intent: "permits",
      radiusMiles: 5,
      minOpenDays: 1825,
      place: "Round Rock",
      openOnly: true,
    });
  });

  it("parses roof-age questions", () => {
    expect(parseQuestion("roofs older than 20 years within 2 miles")).toMatchObject({
      intent: "roofs",
      minRoofAgeYears: 20,
      radiusMiles: 2,
      place: null,
    });
  });
});

describe("Bedrock prompt caching middleware", () => {
  it("adds cache points to the first system and last non-system message", () => {
    const out = applyBedrockPromptCaching([
      { role: "system", content: "sys" },
      { role: "user", content: [{ type: "text", text: "q" }] },
    ]);
    expect(out[0]?.providerOptions?.bedrock).toEqual({ cachePoint: { type: "default" } });
    expect(out[1]?.providerOptions?.bedrock).toEqual({ cachePoint: { type: "default" } });
  });
});
