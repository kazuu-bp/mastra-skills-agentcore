import { BedrockAgentCoreApp, type HealthStatus } from 'bedrock-agentcore/runtime';
import { z } from 'zod';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { mastra } from './mastra/index.js';
import { syncFromS3, syncToS3 } from './hooks/s3-sync.js';
import { logger } from './logger.js';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'ap-northeast-1',
});


// Bedrockクライアントのファクトリ（モデルIDを動的に指定するため）
const bedrock = createAmazonBedrock({
  region: 'ap-northeast-1',
  credentialProvider: fromNodeProviderChain(),
});


logger.info('[agentcore] module loaded');

// GenU形式のメッセージ型
// content は GenU から [{text: "..."}] 配列 or 文字列で来るため z.any() で受け取る
const genuMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.any(),
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
      logger.info({ request }, '[process] called. request:');
      // invoke前: S3からworkspaceにスキルをDL
      await syncFromS3();

      // --- フォーマット判定 ---
      // GenU形式の条件:
      //   (a) messages 配列に要素がある、または
      //   (b) prompt が配列形式（例: [{text: "hello"}]）
      const hasMessages = Array.isArray(request.messages) && request.messages.length > 0;
      const isPromptArray = Array.isArray(request.prompt);
      const isGenu = hasMessages || isPromptArray;

      // Mastraに渡すメッセージ配列を組み立てる
      // GenU形式: messages（過去履歴） + prompt（最新userメッセージ）をマージ
      // 簡昱形式: promptのみを使用
      // CoreMessage互換型をリテラル型で定義
      type CoreMsg = { role: 'user' | 'assistant'; content: string };
      let mastraMessages: CoreMsg[];

      if (isGenu) {
        // 過去履歴を変換（content は [{text: "..."}] 配列 → 文字列）
        const historyMessages: CoreMsg[] = (request.messages ?? []).map((m) => ({
          role: m.role,
          content: Array.isArray(m.content)
            ? (m.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('')
            : String(m.content),
        }));

        // 最新userメッセージを prompt から抽出
        let latestUserContent: string;
        if (isPromptArray) {
          // GenU形式(b): prompt は [{text: "..."}] 配列
          latestUserContent = (request.prompt as Array<{ text?: string }>)
            .map((p) => p.text ?? '')
            .join('');
        } else {
          latestUserContent = typeof request.prompt === 'string' ? request.prompt : '';
        }

        // 過去履歴 + 最新userメッセージ
        mastraMessages = [
          ...historyMessages,
          { role: 'user', content: latestUserContent },
        ];
      } else {
        // 簡易形式: prompt 文字列のみ
        const promptText = typeof request.prompt === 'string' ? request.prompt : '';
        mastraMessages = [{ role: 'user', content: promptText }];
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
      logger.info({ mastraMessages }, '[process] mastraMessages:');
      let result: any;
      try {
        result = await skillsAgent.stream(mastraMessages as any, streamOptions);
        logger.info('[process] stream started');
      } catch (streamErr) {
        logger.error({ err: streamErr }, '[process] stream error:');
        throw streamErr;
      }

      // ストリーミング（Generator）で返す
      // SDKが Content-Type: text/event-stream ヘッダーを自動付与してSSE送信する
      return (async function* () {
        const reader = result.textStream.getReader();
        let contentBlockIndex = 0;

        try {
          let nextRead = reader.read();
          while (true) {
            const timeoutPromise = new Promise<{ timeout: true }>(resolve => setTimeout(() => resolve({ timeout: true }), 2000));
            const readPromise = nextRead.then((res: any) => ({ timeout: false, res }));
            const winner = await Promise.race([timeoutPromise, readPromise]);

            if (winner.timeout) {
              if (isGenu) {
                // GenUタイムアウト対策のキープアライブとして . を送信
                yield {
                  data: {
                    event: {
                      contentBlockDelta: {
                        delta: { text: '.' },
                        contentBlockIndex,
                      },
                    },
                  },
                };
              } else {
                yield { data: { text: '.' } };
              }
              continue; // nextReadの待機を継続
            }

            const { done, value } = winner.res as any;
            if (done) break;

            if (isGenu) {
              // GenU形式の出力: contentBlockDelta を data キーで包んで返す
              // （@fastify/sse が data を自動的にJSON.stringifyするためオブジェクトのまま渡す）
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
            nextRead = reader.read(); // 次のチャンクの読み込みを開始
          }
        } finally {
          // invoke後: workspace/outputs の最新ファイルをS3にアップロードし、URLがあれば返す
          // エラー発生時も必ず実行される（Pythonの finally: clean_ws_directory() に相当）
          const outputData = await syncToS3();
          if (outputData) {
            let outputUrl: string;
            if (isGenu) {
              // GenUの場合は、フロント側でダウンロード用の署名付きURLを取得するため、S3のURLをそのまま返却
              // ただし、アクセスするために以下のロールにS3へのアクセス権を手動で付与する必要がある。
              // ロール： GenerativeAiUseCasesStack-APIGetFileDownloadSignedU-***
              const region = process.env.AWS_REGION || 'ap-northeast-1';
              outputUrl = `https://${outputData.bucketName}.s3.${region}.amazonaws.com/${outputData.s3Key}`;
              const linkText = `\n\n📎  [出力ファイル](${outputUrl})`;
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
              // 通常はここでダウンロード用の署名付きURLを生成して返却
              const command = new GetObjectCommand({
                Bucket: outputData.bucketName,
                Key: outputData.s3Key,
              });
              outputUrl = await getSignedUrl(s3Client, command, { expiresIn: 180 });
              const linkText = `\n\n📎  [出力ファイル](${outputUrl})`;
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
