import { initTRPC, TRPCError } from "@trpc/server";
import { LeadNotFoundError, PropertyNotFoundError } from "./leads/service.js";
import { logger, metrics, MetricUnit } from "./observability.js";
import type { Services } from "./services.js";

export type Context = {
  getServices: () => Promise<Services>;
  requestId: string;
};

// tRPC adds stack traces to error responses unless NODE_ENV=production; Lambda leaves NODE_ENV unset,
// so only expose them when explicitly running in development.
const t = initTRPC.context<Context>().create({ isDev: process.env.NODE_ENV === "development" });

/** Logs, times and counts every procedure; maps domain errors to tRPC codes. */
const observed = t.middleware(async ({ path, type, next, ctx }) => {
  const started = Date.now();
  const result = await next();
  const ms = Date.now() - started;
  metrics.addMetric(result.ok ? "ProcedureSucceeded" : "ProcedureFailed", MetricUnit.Count, 1);
  metrics.addMetric("ProcedureDuration", MetricUnit.Milliseconds, ms);
  if (result.ok) {
    logger.info("procedure", { path, type, ms, requestId: ctx.requestId });
    return result;
  }
  const cause = result.error.cause;
  logger.warn("procedure_failed", {
    path,
    type,
    ms,
    requestId: ctx.requestId,
    code: result.error.code,
    error: result.error.message,
  });
  if (cause instanceof LeadNotFoundError || cause instanceof PropertyNotFoundError) {
    throw new TRPCError({ code: "NOT_FOUND", message: cause.message, cause });
  }
  return result;
});

const withServices = t.middleware(async ({ ctx, next }) =>
  next({ ctx: { services: await ctx.getServices() } }),
);

export const router = t.router;
export const publicProcedure = t.procedure.use(observed).use(withServices);
export const createCallerFactory = t.createCallerFactory;
