import { agentAskInputSchema } from "@roofing-crm/shared";
import { metrics, MetricUnit, traced } from "../observability.js";
import { publicProcedure, router } from "../trpc.js";

export const agentRouter = router({
  /** Natural-language question answered from snapshot retrieval tools (+ LLM when configured). */
  ask: publicProcedure.input(agentAskInputSchema).mutation(async ({ ctx, input }) => {
    const answer = await traced("agent.ask", () => ctx.services.agent.ask(input));
    metrics.addMetric("AgentQuestionAnswered", MetricUnit.Count, 1);
    return answer;
  }),
  mode: publicProcedure.query(({ ctx }) => ({
    mode: ctx.services.agent.mode,
    provider: ctx.services.appConfig.llmProvider,
  })),
});
