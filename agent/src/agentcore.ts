import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime';
import { z } from 'zod';
import { mastra } from './mastra/index.js';

// AgentCore SDKでAPIサーバーを作成
const app = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema: z.object({ prompt: z.string() }) as any,
    process: async function* (request: { prompt: string }) {
      const weatherAgent = mastra.getAgent('weatherAgent');
      // ストリーミングで応答を返却
      const result = await weatherAgent.stream([{ role: 'user', content: request.prompt }])
      const reader = result.textStream.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        yield { data: { text: value } }
      }
    },
  },
});

// サーバーを起動
app.run();
