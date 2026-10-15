import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, Context } from "aws-lambda";
import { beforeAll, describe, expect, it } from "vitest";
import { fixtureSnapshot } from "./helpers.js";

let handler: (e: APIGatewayProxyEventV2, c: Context) => Promise<unknown>;

beforeAll(async () => {
  process.env.CRM_DATA_BASE_URL = await fixtureSnapshot();
  process.env.CRM_LEADS_STORE = "memory";
  process.env.LLM_PROVIDER = "none";
  ({ handler } = await import("../src/handler.js"));
});

function event(proc: string, method: "GET" | "POST", body?: unknown, query?: string): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "ANY /trpc/{proxy+}",
    rawPath: `/trpc/${proc}`,
    rawQueryString: query ?? "",
    queryStringParameters: query ? Object.fromEntries(new URLSearchParams(query)) : undefined,
    headers: { "content-type": "application/json" },
    pathParameters: { proxy: proc },
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: {
      accountId: "123",
      apiId: "api",
      domainName: "example.execute-api.us-east-2.amazonaws.com",
      domainPrefix: "example",
      http: {
        method,
        path: `/trpc/${proc}`,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "vitest",
      },
      requestId: "req",
      routeKey: "ANY /trpc/{proxy+}",
      stage: "$default",
      time: "",
      timeEpoch: 0,
    },
  };
}

const context = {
  awsRequestId: "req-1",
  functionName: "fn",
  getRemainingTimeInMillis: () => 10_000,
} as unknown as Context;

describe("Lambda handler (API Gateway HTTP API v2)", () => {
  it("serves queries", async () => {
    const res = (await handler(event("meta.health", "GET"), context)) as APIGatewayProxyStructuredResultV2;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(String(res.body))).toMatchObject({
      result: { data: { ok: true, runId: "fixture-run-0001" } },
    });
  });

  it("serves mutations", async () => {
    const res = (await handler(
      event("leads.create", "POST", { propId: "P1" }),
      context,
    )) as APIGatewayProxyStructuredResultV2;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(String(res.body)).result.data.lead.id).toBe("lead_P1");
  });

  it("maps validation errors to 400", async () => {
    const res = (await handler(
      event("leads.create", "POST", { propId: "" }),
      context,
    )) as APIGatewayProxyStructuredResultV2;
    expect(res.statusCode).toBe(400);
  });
});
