import * as cdk from "aws-cdk-lib/core";
import { Construct } from "constructs";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import { ContainerImageBuild } from "@cdklabs/deploy-time-build";
import * as agentcore from "@aws-cdk/aws-bedrock-agentcore-alpha";
import * as iam from "aws-cdk-lib/aws-iam";
import * as path from "path";

export class AgentcoreStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ========================================
    // ECR（deploy-time-build によるリモートビルド）
    // ========================================
    // agent/ ディレクトリの Dockerfile を使用して
    // CodeBuild 上でコンテナイメージをビルド・ECR へプッシュする
    const image = new ContainerImageBuild(this, "Image", {
      directory: path.join(__dirname, "../agent"), // agent/ ディレクトリ
      platform: Platform.LINUX_ARM64,
      exclude: [
        "node_modules",
        ".git",
        ".mastra",
        "*.db",
        "*.db-shm",
        "*.db-wal",
        ".env",
        ".env.*",
        "output.txt",
      ],
    });

    // ========================================
    // AgentCore Runtime
    // ========================================
    const agentRuntimeArtifact =
      agentcore.AgentRuntimeArtifact.fromEcrRepository(
        image.repository,
        image.imageTag
      );

    const runtime = new agentcore.Runtime(this, "MastraRuntime", {
      runtimeName: `mastra_agentcore`,
      agentRuntimeArtifact: agentRuntimeArtifact,
      description: "Mastra Skills AgentCore Runtime",
    });

    // Bedrock モデル呼び出し権限を付与
    runtime.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
          "bedrock:Converse",
          "bedrock:ConverseStream",
          "bedrock:GetInferenceProfile",
          "bedrock:ListInferenceProfiles",
        ],
        resources: ["*"],
      })
    );

    // ========================================
    // CloudFormation Outputs
    // ========================================
    new cdk.CfnOutput(this, "RuntimeArn", {
      value: runtime.agentRuntimeArn,
      description: "AgentCore Runtime の ARN",
    });
  }
}
