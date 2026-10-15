import * as cdk from "aws-cdk-lib";
import { ApiStack } from "../lib/api-stack.js";
import { readContext } from "../lib/context.js";
import { WebStack } from "../lib/web-stack.js";

const app = new cdk.App();
const ctx = readContext(app);
// Region is fixed to us-east-2 (Golden Path). Account is optional so `cdk synth` works without credentials;
// no context lookups are performed anywhere in the app.
const env = { region: "us-east-2", account: process.env.CDK_DEFAULT_ACCOUNT };

cdk.Tags.of(app).add("project_name", ctx.projectName);

const api = new ApiStack(app, "RoofingCrmApi", {
  env,
  ctx,
  description: "Roofing CRM tRPC API (Lambda + HTTP API + DynamoDB)",
});
new WebStack(app, "RoofingCrmWeb", {
  env,
  ctx,
  apiUrl: api.apiUrl,
  description: "Roofing CRM web app (S3 + CloudFront)",
});
