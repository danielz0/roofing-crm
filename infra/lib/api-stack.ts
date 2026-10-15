import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cdk from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import { Construct } from "constructs";
import type { DeployContext } from "./context.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "../..");
const API_DIR = path.join(REPO_ROOT, "apps/api");

/** DuckDB version pinned by apps/api/package.json, e.g. "1.5.6-r.1" -> node package + engine "v1.5.6". */
export function duckdbVersions(): { nodeApi: string; engine: string } {
  const pkg = JSON.parse(readFileSync(path.join(API_DIR, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  const nodeApi = pkg.dependencies["@duckdb/node-api"];
  if (!nodeApi || !/^\d+\.\d+\.\d+/.test(nodeApi))
    throw new Error("apps/api must pin an exact @duckdb/node-api version");
  return { nodeApi, engine: `v${/^\d+\.\d+\.\d+/.exec(nodeApi)![0]}` };
}

export const DUCKDB_EXTENSIONS = ["httpfs", "fts"] as const;

export class ApiStack extends cdk.Stack {
  readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: cdk.StackProps & { ctx: DeployContext }) {
    super(scope, id, props);
    const { ctx } = props;
    const duck = duckdbVersions();

    // ---------------------------------------------------------------- CRM leads table
    const table = new dynamodb.TableV2(this, "LeadsTable", {
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: ctx.retainData ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      globalSecondaryIndexes: [
        {
          indexName: "byStatus",
          partitionKey: { name: "status", type: dynamodb.AttributeType.STRING },
          sortKey: { name: "updatedAt", type: dynamodb.AttributeType.STRING },
        },
      ],
    });

    // ---------------------------------------------------------------- tRPC Lambda
    const logGroup = new logs.LogGroup(this, "ApiLogs", {
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const extDir = `duckdb_extensions/${duck.engine}/linux_amd64`;
    const environment: Record<string, string> = {
      NODE_OPTIONS: "--enable-source-maps",
      HOME: "/tmp",
      POWERTOOLS_SERVICE_NAME: ctx.projectName,
      POWERTOOLS_METRICS_NAMESPACE: "RoofingCrm",
      POWERTOOLS_LOG_LEVEL: "INFO",
      CRM_DATA_BASE_URL: ctx.dataBaseUrl ?? "",
      CRM_DATA_MODE: ctx.dataMode,
      CRM_DUCKDB_EXTENSION_DIR: "/var/task/duckdb_extensions",
      CRM_DUCKDB_OFFLINE: "true",
      CRM_DUCKDB_MEMORY_LIMIT: `${Math.floor(ctx.lambdaMemoryMb * 0.7)}MB`,
      CRM_LEADS_STORE: "dynamodb",
      CRM_LEADS_TABLE: table.tableName,
      LLM_PROVIDER: ctx.llmProvider,
      LLM_REGION: "us-east-2",
      CRM_EMBEDDINGS: ctx.embeddings ?? "none",
    };
    if (ctx.llmModelId) environment.LLM_MODEL_ID = ctx.llmModelId;
    if (ctx.roofAgeThresholdYears) environment.CRM_ROOF_AGE_THRESHOLD_YEARS = ctx.roofAgeThresholdYears;
    if (ctx.longOpenPermitDays) environment.CRM_LONG_OPEN_PERMIT_DAYS = ctx.longOpenPermitDays;
    if (!ctx.dataBaseUrl) {
      cdk.Annotations.of(this).addWarning(
        "Context 'dataBaseUrl' is not set; the API will report CRM_DATA_BASE_URL missing. Deploy with -c dataBaseUrl=https://<gateway>/ipfs/<rootCid>",
      );
    }

    const fn = new nodejs.NodejsFunction(this, "TrpcHandler", {
      entry: path.join(API_DIR, "src/handler.ts"),
      handler: "handler",
      projectRoot: REPO_ROOT,
      depsLockFilePath: path.join(REPO_ROOT, "pnpm-lock.yaml"),
      runtime: lambda.Runtime.NODEJS_22_X,
      // DuckDB ships native bindings per platform; the bundle contains the linux-x64 build.
      architecture: lambda.Architecture.X86_64,
      memorySize: ctx.lambdaMemoryMb,
      timeout: cdk.Duration.seconds(29),
      tracing: lambda.Tracing.ACTIVE,
      logGroup,
      loggingFormat: lambda.LoggingFormat.JSON,
      environment,
      bundling: {
        format: nodejs.OutputFormat.ESM,
        target: "node22",
        mainFields: ["module", "main"],
        sourceMap: true,
        minify: true,
        banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
        // Native module: not bundled by esbuild, installed for linux-x64 below.
        externalModules: ["@duckdb/node-api", "@duckdb/node-bindings"],
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (_inputDir: string, outputDir: string) => [
            // 1) DuckDB node API + the linux-x64 native binding, regardless of the synth host OS.
            `cd "${outputDir}" && printf '{"type":"module","private":true}' > package.json`,
            `cd "${outputDir}" && npm install --no-save --no-package-lock --no-audit --no-fund --omit=dev --os=linux --cpu=x64 --libc=glibc @duckdb/node-api@${duck.nodeApi}`,
            // 2) Pre-bundled DuckDB extensions (no network INSTALL at runtime).
            `mkdir -p "${outputDir}/${extDir}"`,
            ...DUCKDB_EXTENSIONS.map(
              (ext) =>
                `curl -sSfL "https://extensions.duckdb.org/${duck.engine}/linux_amd64/${ext}.duckdb_extension.gz" | gunzip > "${outputDir}/${extDir}/${ext}.duckdb_extension"`,
            ),
          ],
        },
      },
    });
    if (ctx.provisionedConcurrency && ctx.provisionedConcurrency > 0) {
      new lambda.Alias(this, "LiveAlias", {
        aliasName: "live",
        version: fn.currentVersion,
        provisionedConcurrentExecutions: ctx.provisionedConcurrency,
      });
    }

    table.grantReadWriteData(fn);
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "BedrockInvoke",
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: [
          "arn:aws:bedrock:*::foundation-model/anthropic.*",
          "arn:aws:bedrock:*::foundation-model/amazon.titan-embed-*",
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*`,
        ],
      }),
    );

    // ---------------------------------------------------------------- HTTP API
    const httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: `${ctx.projectName}-api`,
      corsPreflight: {
        allowOrigins: ctx.corsOrigins ?? ["*"],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ["content-type", "authorization", "trpc-accept"],
        maxAge: cdk.Duration.hours(1),
      },
    });
    const defaultStage = httpApi.defaultStage?.node.defaultChild as apigwv2.CfnStage | undefined;
    defaultStage?.addPropertyOverride("DefaultRouteSettings", {
      ThrottlingBurstLimit: 100,
      ThrottlingRateLimit: 50,
    });
    httpApi.addRoutes({
      path: "/trpc/{proxy+}",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration("TrpcIntegration", fn),
    });

    if (ctx.apiDomainName && ctx.apiBasePath && httpApi.defaultStage) {
      // Maps onto an existing custom domain (created once per account outside this stack).
      new apigwv2.CfnApiMapping(this, "ApiMapping", {
        apiId: httpApi.apiId,
        domainName: ctx.apiDomainName,
        stage: httpApi.defaultStage.stageName,
        apiMappingKey: ctx.apiBasePath,
      });
      this.apiUrl = `https://${ctx.apiDomainName}/${ctx.apiBasePath}`;
    } else {
      this.apiUrl = httpApi.apiEndpoint;
    }

    // ---------------------------------------------------------------- alarms (self-resolving)
    const topic = new sns.Topic(this, "AlarmTopic", { displayName: `${ctx.projectName} alarms` });
    if (ctx.alarmEmail) topic.addSubscription(new subs.EmailSubscription(ctx.alarmEmail));
    if (ctx.pagerDutyEndpoint) topic.addSubscription(new subs.UrlSubscription(ctx.pagerDutyEndpoint));
    const alarm = (aid: string, metric: cloudwatch.IMetric, threshold: number, description: string) => {
      const a = new cloudwatch.Alarm(this, aid, {
        metric,
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: description,
      });
      a.addAlarmAction(new cwActions.SnsAction(topic));
      a.addOkAction(new cwActions.SnsAction(topic));
    };
    alarm(
      "LambdaErrors",
      fn.metricErrors({ period: cdk.Duration.minutes(5) }),
      5,
      "tRPC Lambda errors >= 5 in 5 minutes",
    );
    alarm(
      "LambdaThrottles",
      fn.metricThrottles({ period: cdk.Duration.minutes(5) }),
      1,
      "tRPC Lambda throttled",
    );
    alarm(
      "Api5xx",
      httpApi.metricServerError({ period: cdk.Duration.minutes(5) }),
      5,
      "HTTP API 5xx responses >= 5 in 5 minutes",
    );

    new cdk.CfnOutput(this, "ApiUrl", { value: this.apiUrl });
    new cdk.CfnOutput(this, "LeadsTableName", { value: table.tableName });
    new cdk.CfnOutput(this, "AlarmTopicArn", { value: topic.topicArn });
  }
}
