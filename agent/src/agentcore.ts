import { BedrockAgentCoreApp, type HealthStatus } from 'bedrock-agentcore/runtime';
import { z } from 'zod';
import { mastra } from './mastra/index.js';
import { syncFromS3, syncToS3 } from './hooks/s3-sync.js';

// AgentCore SDKでAPIサーバーを作成
const app = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema: z.object({ prompt: z.string() }) as any,
    process: async function* (request: { prompt: string }) {
      // invoke前: S3からworkspaceにスキルをDL
      await syncFromS3();

      const skillsAgent = mastra.getAgent('skillsAgent');
      // ストリーミングで応答を返却
      const result = await skillsAgent.stream([{ role: 'user', content: request.prompt }])
      const reader = result.textStream.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        yield { data: { text: value } }
      }

      // invoke後: workspace変更をS3にUP
      await syncToS3();
    },
  },
  pingHandler: async (): Promise<HealthStatus> => 'Healthy',
});

// サーバーを起動
app.run();

