import * as cdk from "aws-cdk-lib/core";
import { Construct } from "constructs";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import { ContainerImageBuild } from "@cdklabs/deploy-time-build";
import * as agentcore from "@aws-cdk/aws-bedrock-agentcore-alpha";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as path from "path";

export class AgentcoreStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ========================================
    // S3（スキル・ワークスペース同期用）
    // ========================================
    const skillsBucket = new s3.Bucket(this, "SkillsBucket", {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    new s3deploy.BucketDeployment(this, "DeploySkillsWorkspace", {
      sources: [s3deploy.Source.asset(path.join(__dirname, "../s3/workspace"))],
      destinationBucket: skillsBucket,
      destinationKeyPrefix: "workspace",
    });

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
        "public"
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
      environmentVariables: {
        SKILLS_BUCKET_NAME: skillsBucket.bucketName,
        WORKSPACE_PATH: "/app/workspace",
      },
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

    // S3 読み書き権限を付与
    skillsBucket.grantReadWrite(runtime.role);

    // CloudWatch Logs 書き込み権限を付与
    runtime.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "logs:DescribeLogStreams",
          "logs:CreateLogGroup",
        ],
        resources: ["*"],
      })
    );

    runtime.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["logs:DescribeLogGroups"],
        resources: ["*"],
      })
    );

    runtime.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        resources: ["*"],
      })
    );

    // X-Ray トレーシング権限を付与
    runtime.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "xray:PutTraceSegments",
          "xray:PutTelemetryRecords",
          "xray:GetSamplingRules",
          "xray:GetSamplingTargets",
        ],
        resources: ["*"],
      })
    );

    // CloudWatch メトリクス権限を付与（bedrock-agentcore ネームスペースに限定）
    runtime.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
        conditions: {
          StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' },
        },
      })
    );

    // ========================================
    // CloudFormation Outputs
    // ========================================
    new cdk.CfnOutput(this, "RuntimeArn", {
      value: runtime.agentRuntimeArn,
      description: "AgentCore Runtime の ARN",
    });

    new cdk.CfnOutput(this, "SkillsBucketName", {
      value: skillsBucket.bucketName,
      description: "スキル同期用 S3 バケット名",
    });
  }
}

