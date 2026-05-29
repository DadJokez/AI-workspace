#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AiWorkspaceEcsStack } from "../lib/ai-workspace-ecs-stack.js";
import { AiWorkspaceRuntimeV2PreviewStack } from "../lib/ai-workspace-runtime-v2-preview-stack.js";

const app = new cdk.App();

new AiWorkspaceEcsStack(app, "AiWorkspaceEcsStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
});

new AiWorkspaceRuntimeV2PreviewStack(app, "AiWorkspaceRuntimeV2PreviewStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
});
