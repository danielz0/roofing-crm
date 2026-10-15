import { existsSync } from "node:fs";
import path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";
import { REPO_ROOT } from "./api-stack.js";
import type { DeployContext } from "./context.js";

export const WEB_DIST = path.join(REPO_ROOT, "apps/web/dist");

/**
 * Static hosting for apps/web: private S3 bucket behind CloudFront (Origin Access Control).
 * `config.json` is generated at deploy time with the API URL so the same build works in every environment.
 */
export class WebStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: cdk.StackProps & { ctx: DeployContext; apiUrl: string; webDist?: string },
  ) {
    super(scope, id, props);
    const dist = props.webDist ?? WEB_DIST;
    if (!existsSync(path.join(dist, "index.html"))) {
      throw new Error(
        `Web build not found at ${dist}. Run "pnpm --filter @roofing-crm/web build" (or "pnpm synth") first.`,
      );
    }

    const bucket = new s3.Bucket(this, "WebBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const headers = new cloudfront.ResponseHeadersPolicy(this, "SecurityHeaders", {
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
      },
    });

    const distribution = new cloudfront.Distribution(this, "WebDistribution", {
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
      },
      additionalBehaviors: {
        "/config.json": {
          origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        },
      },
      // SPA: unknown paths fall back to index.html.
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: cdk.Duration.seconds(0),
        },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    new s3deploy.BucketDeployment(this, "DeployWeb", {
      destinationBucket: bucket,
      sources: [
        s3deploy.Source.asset(dist),
        s3deploy.Source.jsonData("config.json", { apiUrl: props.apiUrl }),
      ],
      distribution,
      distributionPaths: ["/*"],
      memoryLimit: 512,
    });

    new cdk.CfnOutput(this, "WebUrl", { value: `https://${distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, "WebBucketName", { value: bucket.bucketName });
  }
}
