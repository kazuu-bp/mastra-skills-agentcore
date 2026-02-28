#!/usr/bin/env node
import * as cdk from "aws-cdk-lib/core";
import { AgentcoreStack } from "../lib/agentcore-stack";

const app = new cdk.App();

new AgentcoreStack(app, "MastraAgentcoreStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || "us-east-1",
  },
});
