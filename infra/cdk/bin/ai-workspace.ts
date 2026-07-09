#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AiWorkspaceEcsStack } from "../lib/ai-workspace-ecs-stack.js";
import { AiWorkspaceAgentCoreSpikeStack } from "../lib/ai-workspace-agentcore-spike-stack.js";

const app = new cdk.App();

new AiWorkspaceEcsStack(app, "AiWorkspaceEcsStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
});


new AiWorkspaceAgentCoreSpikeStack(app, "AiWorkspaceAgentCoreSpikeStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
});
