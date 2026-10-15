import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { duckdbVersions } from "../lib/api-stack.js";
import { readContext } from "../lib/context.js";
import { WebStack } from "../lib/web-stack.js";

/**
 * The API stack bundles the Lambda (esbuild + npm + extension download), so its template test runs only
 * when CDK_BUNDLING_TESTS=1 (CI synth covers it). The web stack and helpers are always tested.
 */
describe("web stack", () => {
  it("serves a private bucket through CloudFront with SPA fallback and runtime config", () => {
    const dist = mkdtempSync(path.join(tmpdir(), "web-dist-"));
    writeFileSync(path.join(dist, "index.html"), "<html></html>");
    const app = new cdk.App({ context: { projectName: "roofing-crm" } });
    cdk.Tags.of(app).add("project_name", "roofing-crm");
    const stack = new WebStack(app, "Web", {
      env: { region: "us-east-2" },
      ctx: readContext(app),
      apiUrl: "https://api.example.test",
      webDist: dist,
    });
    const t = Template.fromStack(stack);
    t.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: Match.objectLike({
        BlockPublicAcls: true,
        RestrictPublicBuckets: true,
      }),
      Tags: Match.arrayWith([{ Key: "project_name", Value: "roofing-crm" }]),
    });
    t.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: "index.html",
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({ ErrorCode: 404, ResponsePagePath: "/index.html" }),
        ]),
      }),
    });
    t.resourceCountIs("Custom::CDKBucketDeployment", 1);
  });

  it("fails fast when the web build is missing", () => {
    const app = new cdk.App();
    expect(
      () =>
        new WebStack(app, "Web", {
          ctx: readContext(app),
          apiUrl: "x",
          webDist: path.join(tmpdir(), "does-not-exist"),
        }),
    ).toThrow(/Web build not found/);
  });
});

describe("deploy context", () => {
  it("defaults are safe", () => {
    const ctx = readContext(new cdk.App());
    expect(ctx).toMatchObject({
      projectName: "roofing-crm",
      dataMode: "view",
      llmProvider: "bedrock",
      lambdaMemoryMb: 3008,
      retainData: true,
    });
  });

  it("parses overrides", () => {
    const app = new cdk.App({
      context: {
        dataBaseUrl: "https://ipfs.io/ipfs/bafy",
        llmProvider: "none",
        corsOrigins: "https://a,https://b",
      },
    });
    expect(readContext(app)).toMatchObject({
      dataBaseUrl: "https://ipfs.io/ipfs/bafy",
      llmProvider: "none",
      corsOrigins: ["https://a", "https://b"],
    });
  });
});

describe("duckdb packaging", () => {
  it("derives the engine version used for extension downloads from the pinned node package", () => {
    const v = duckdbVersions();
    expect(v.nodeApi).toMatch(/^\d+\.\d+\.\d+/);
    expect(v.engine).toMatch(/^v\d+\.\d+\.\d+$/);
  });
});

describe.runIf(process.env.CDK_BUNDLING_TESTS === "1")("api stack (bundles the Lambda)", () => {
  it("defines Lambda, HTTP API route, DynamoDB table, Bedrock IAM and alarms", async () => {
    const { ApiStack } = await import("../lib/api-stack.js");
    const app = new cdk.App({ context: { dataBaseUrl: "https://ipfs.io/ipfs/bafytest" } });
    const stack = new ApiStack(app, "Api", { env: { region: "us-east-2" }, ctx: readContext(app) });
    const t = Template.fromStack(stack);
    t.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      Architectures: ["x86_64"],
      TracingConfig: { Mode: "Active" },
      Environment: {
        Variables: Match.objectLike({
          CRM_LEADS_STORE: "dynamodb",
          CRM_DATA_BASE_URL: "https://ipfs.io/ipfs/bafytest",
        }),
      },
    });
    t.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "GET /trpc/{proxy+}" });
    t.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
      GlobalSecondaryIndexes: [Match.objectLike({ IndexName: "byStatus" })],
    });
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Sid: "BedrockInvoke" })]) },
    });
    t.resourceCountIs("AWS::CloudWatch::Alarm", 3);
    t.hasResourceProperties("AWS::Logs::LogGroup", { RetentionInDays: 90 });
  });
});
