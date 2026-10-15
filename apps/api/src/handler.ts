import type { APIGatewayProxyEventV2, Context as LambdaContext } from "aws-lambda";
import { awsLambdaRequestHandler } from "@trpc/server/adapters/aws-lambda";
import { logger, metrics, tracer } from "./observability.js";
import { appRouter } from "./routers/index.js";
import { getServices } from "./services.js";

/**
 * API Gateway HTTP API (payload v2) -> tRPC. The route is `/trpc/{proxy+}`, so the tRPC procedure path
 * comes from the `proxy` path parameter. Services (DuckDB snapshot, repositories, agent) are created once
 * per execution environment and reused across invocations.
 */
const trpcHandler = awsLambdaRequestHandler({
  router: appRouter,
  createContext: ({ context }: { context: LambdaContext }) => ({
    getServices,
    requestId: context.awsRequestId,
  }),
  onError: ({ error, path }) => {
    if (error.code === "INTERNAL_SERVER_ERROR") logger.error("trpc_internal_error", { path, error });
  },
});

export const handler = async (event: APIGatewayProxyEventV2, context: LambdaContext) => {
  logger.addContext(context);
  tracer.annotateColdStart();
  tracer.addServiceNameAnnotation();
  try {
    return await trpcHandler(event, context);
  } finally {
    metrics.publishStoredMetrics();
  }
};
