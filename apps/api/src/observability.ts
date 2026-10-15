import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import { Tracer } from "@aws-lambda-powertools/tracer";

const serviceName = process.env.POWERTOOLS_SERVICE_NAME ?? "roofing-crm-api";

export const logger = new Logger({ serviceName });
export const tracer = new Tracer({ serviceName, enabled: Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME) });
export const metrics = new Metrics({
  serviceName,
  namespace: process.env.POWERTOOLS_METRICS_NAMESPACE ?? "RoofingCrm",
});

export { MetricUnit };

/** Wrap an async operation in an X-Ray subsegment (no-op outside Lambda). */
export async function traced<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const parent = tracer.getSegment();
  const sub = parent?.addNewSubsegment(name);
  if (sub) tracer.setSegment(sub);
  try {
    return await fn();
  } catch (err) {
    sub?.addError(err as Error);
    throw err;
  } finally {
    sub?.close();
    if (parent) tracer.setSegment(parent);
  }
}
