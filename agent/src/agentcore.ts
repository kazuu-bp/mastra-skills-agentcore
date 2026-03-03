import { BedrockAgentCoreApp, type HealthStatus } from 'bedrock-agentcore/runtime';
import { z } from 'zod';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { mastra } from './mastra/index.js';
import { syncFromS3, syncToS3 } from './hooks/s3-sync.js';

// Bedrockクライアントのファクトリ（モデルIDを動的に指定するため）
const bedrock = createAmazonBedrock({
  region: 'ap-northeast-1',
  credentialProvider: fromNodeProviderChain(),
});

// GenU形式のメッセージ型
const genuMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
});

// リクエストスキーマ: GenU形式と簡易形式の両方を受け取れるよう定義
const requestSchema = z.object({
  // 簡易形式: { prompt: string }
  prompt: z.union([
    z.string(),          // 簡易形式: 文字列プロンプト
    z.array(z.any()),    // GenU形式: prompt は配列（未使用、messages を優先）
  ]).optional(),

  // GenU形式: { messages: [...] }
  messages: z.array(genuMessageSchema).optional(),

  // GenU追加フィールド（無視するが受け取れるようにしておく）
  system_prompt: z.string().optional(),
  model: z.record(z.string(), z.any()).optional(),
  user_id: z.string().optional(),
  mcp_servers: z.any().optional(),
  session_id: z.string().optional(),
  agent_id: z.string().optional(),
  code_execution_enabled: z.boolean().optional(),
});

// AgentCore SDKでAPIサーバーを作成
const app = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema: requestSchema as any,
    process: async function* (request: z.infer<typeof requestSchema>) {
      // invoke前: S3からworkspaceにスキルをDL
      await syncFromS3();

      // --- フォーマット判定 ---
      // GenU形式: messages 配列に最後のユーザーメッセージがある
      const isGenu = Array.isArray(request.messages) && request.messages.length > 0;

      // プロンプト抽出
      let promptText: string;
      if (isGenu) {
        // GenU形式: messages の最後の user ロールのメッセージを使用
        const lastUserMsg = [...(request.messages ?? [])]
          .reverse()
          .find((m) => m.role === 'user');
        promptText = lastUserMsg?.content ?? '';
      } else {
        // 簡易形式: prompt は文字列
        promptText = typeof request.prompt === 'string' ? request.prompt : '';
      }

      const skillsAgent = mastra.getAgent('skillsAgent');

      // GenU形式の場合: model.modelId を使って動的にモデルインスタンスを生成
      const modelId = isGenu
        ? (request.model?.['modelId'] as string | undefined)
        : undefined;
      const dynamicModel = modelId
        ? bedrock(modelId)
        : undefined;

      // ストリーミングで応答を返却（dynamicModelがある場合は上書き）
      const streamOptions = dynamicModel ? { model: dynamicModel } as any : undefined;
      const result = await skillsAgent.stream([{ role: 'user', content: promptText }], streamOptions);
      const reader = result.textStream.getReader();
      let contentBlockIndex = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (isGenu) {
          // GenU形式の出力: contentBlockDelta を data キーで包んで返す
          yield {
            data: {
              event: {
                contentBlockDelta: {
                  delta: { text: value },
                  contentBlockIndex,
                },
              },
            },
          };
        } else {
          // 簡易形式の出力
          yield { data: { text: value } };
        }
        contentBlockIndex++;
      }

      // invoke後: workspace/outputs の最新ファイルをS3にアップロードし、URLがあれば返す
      const outputUrl = await syncToS3();
      if (outputUrl) {
        const linkText = `\n\n📎  [出力ファイル](${outputUrl})`;
        if (isGenu) {
          yield {
            data: {
              event: {
                contentBlockDelta: {
                  delta: { text: linkText },
                  contentBlockIndex,
                },
              },
            },
          };
        } else {
          yield { data: { text: linkText } };
        }
      }
    },
  },
  pingHandler: async (): Promise<HealthStatus> => 'Healthy',
});

// サーバーを起動
app.run();
