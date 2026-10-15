import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { wrapLanguageModel, type EmbeddingModel, type LanguageModel, type LanguageModelMiddleware } from "ai";
import type { AppConfigResolved } from "../config.js";

type TransformParams = NonNullable<LanguageModelMiddleware["transformParams"]>;
type CallParams = Parameters<TransformParams>[0]["params"];
type PromptMessage = CallParams["prompt"][number];

const BEDROCK_CACHE_POINT = { type: "default" as const };

function withCachePoint(message: PromptMessage): PromptMessage {
  const providerOptions = message.providerOptions ?? {};
  const bedrock =
    typeof providerOptions.bedrock === "object" && providerOptions.bedrock !== null
      ? providerOptions.bedrock
      : {};
  return {
    ...message,
    providerOptions: { ...providerOptions, bedrock: { ...bedrock, cachePoint: BEDROCK_CACHE_POINT } },
  };
}

/** Add Bedrock cache points to the first system message and the last non-system message. */
export function applyBedrockPromptCaching(prompt: CallParams["prompt"]): CallParams["prompt"] {
  const targets = new Set<number>();
  const firstSystem = prompt.findIndex((m) => m.role === "system");
  if (firstSystem >= 0) targets.add(firstSystem);
  for (let i = prompt.length - 1; i >= 0; i--) {
    if (prompt[i]?.role !== "system") {
      targets.add(i);
      break;
    }
  }
  return prompt.map((m, i) => (targets.has(i) ? withCachePoint(m) : m));
}

export const bedrockPromptCachingMiddleware: LanguageModelMiddleware = {
  transformParams: async ({ params }) => ({ ...params, prompt: applyBedrockPromptCaching(params.prompt) }),
};

/**
 * Build the configured chat model. Bedrock is the default and uses the AWS credential provider chain
 * (Lambda execution role in AWS, profile/SSO locally). Returns null when LLM_PROVIDER=none.
 */
export function createChatModel(config: AppConfigResolved): LanguageModel | null {
  const modelId = config.llmModelId;
  if (!modelId) return null;
  switch (config.LLM_PROVIDER) {
    case "bedrock": {
      const bedrock = createAmazonBedrock({
        region: config.LLM_REGION,
        credentialProvider: fromNodeProviderChain(),
      });
      return wrapLanguageModel({ model: bedrock(modelId), middleware: bedrockPromptCachingMiddleware });
    }
    case "anthropic":
      return createAnthropic()(modelId);
    case "openai":
      return createOpenAI()(modelId);
    case "none":
      return null;
  }
}

export function createEmbeddingModel(config: AppConfigResolved): EmbeddingModel | null {
  if (config.CRM_EMBEDDINGS !== "bedrock-titan") return null;
  const bedrock = createAmazonBedrock({
    region: config.LLM_REGION,
    credentialProvider: fromNodeProviderChain(),
  });
  return bedrock.embedding(config.CRM_EMBEDDING_MODEL_ID);
}
