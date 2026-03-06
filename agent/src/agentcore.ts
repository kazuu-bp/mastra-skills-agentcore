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
    z.string(),                                    // 簡易形式: 文字列プロンプト
    z.array(z.object({ text: z.string() })),       // GenU形式: [{text: "..."}] 配列
    z.array(z.any()),                              // その他の配列形式（フォールバック）
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
  // application/octet-stream で送られてくるリクエストを JSON としてパースする
  config: {
    contentTypeParsers: [
      {
        contentType: 'application/octet-stream',
        parseAs: 'buffer' as const,
        parser: (req: any, body: string | Buffer, done: (err: Error | null, body?: unknown) => void) => {
          try {
            const text = typeof body === 'string' ? body : body.toString('utf-8');
            const json = JSON.parse(text);
            done(null, json);
          } catch (err) {
            done(err as Error);
          }
        },
      },
    ],
  },
  invocationHandler: {
    requestSchema: requestSchema as any,
    process: async function (request: z.infer<typeof requestSchema>, context: any) {
      console.error('Request:', JSON.stringify(request, null, 2));
      // invoke前: S3からworkspaceにスキルをDL
      await syncFromS3();

      // --- フォーマット判定 ---
      // GenU形式の条件:
      //   (a) messages 配列に要素がある、または
      //   (b) prompt が配列形式（例: [{text: "hello"}]）
      const hasMessages = Array.isArray(request.messages) && request.messages.length > 0;
      const isPromptArray = Array.isArray(request.prompt);
      const isGenu = hasMessages || isPromptArray;

      // プロンプト抽出
      let promptText: string;
      if (hasMessages) {
        // GenU形式(a): messages の最後の user ロールのメッセージを使用
        const lastUserMsg = [...(request.messages ?? [])]
          .reverse()
          .find((m) => m.role === 'user');
        promptText = lastUserMsg?.content ?? '';
      } else if (isPromptArray) {
        // GenU形式(b): prompt 配列の各要素の text を结合
        promptText = (request.prompt as Array<{ text?: string }>)
          .map((p) => p.text ?? '')
          .join('');
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

      // ストリーミング（Generator）で返す
      // SDKが Content-Type: text/event-stream ヘッダーを自動付与してSSE送信する
      return (async function* () {
        const reader = result.textStream.getReader();
        let contentBlockIndex = 0;

        try {
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
        } finally {
          // invoke後: workspace/outputs の最新ファイルをS3にアップロードし、URLがあれば返す
          // エラー発生時も必ず実行される（Pythonの finally: clean_ws_directory() に相当）
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
        }
      })();
    },
  },
  pingHandler: async (): Promise<HealthStatus> => 'Healthy',
});

// サーバーを起動
app.run();
