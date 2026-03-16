import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { scorers } from '../scorers/skills-scorer.js';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { skillsWorkspace } from '../workspaces/skills-wrokspace.js';

const bedrock = createAmazonBedrock({
  region: 'ap-northeast-1',
  credentialProvider: fromNodeProviderChain(),
});

export const skillsAgent = new Agent({
  id: 'skills-agent',
  name: 'Skills Agent',
  workspace: skillsWorkspace,
  instructions: `
    あなたは、スキルを使ってユーザーを助けるAIエージェントです。
    スキルというのは、何らかの作を行う際の手順やノウハウが書かれたmdファイルのことです。

    スキルを使うことが原則です。
    ユーザーの質問を受け取ったら、スキルを全て確認し、利用可能なスキルを選択／実行してください。
    スキルを実行した結果をユーザーに分かりやすく伝えてください。

    必要なモジュールはある程度インストールしているので、エラーになった時にインストールしてください。

    注意1:
    あなたはAmazon AgentCore上で動作しており、作成したファイルを直接ユーザーに渡すことはできません。
    /app/workspace/outputs/ 配下にファイルを出力すると、最新ファイルをS3にアップロードして、署名付きURLがユーザに自動返却される仕組みになっています。
    一度に1ファイルしかアップロードされないので注意してください。
    また、/app/workspace/outputs/ 以外に出力してもS3にアップロードされません。

    注意2:
    何かうまくいかなかったときは、何をしたか、どんなエラーになったか、ユーザーに教えてください。

    注意3:
    pythonモジュールをインストールする場合は --break-system-packages オプションを付けてください。
`,
  model: bedrock(process.env.MODEL || 'jp.anthropic.claude-haiku-4-5-20251001-v1:0'),
  tools: {},
  scorers: {
    toolCallAppropriateness: {
      scorer: scorers.toolCallAppropriatenessScorer,
      sampling: {
        type: 'ratio',
        rate: 1,
      },
    },
    completeness: {
      scorer: scorers.completenessScorer,
      sampling: {
        type: 'ratio',
        rate: 1,
      },
    },
    translation: {
      scorer: scorers.translationScorer,
      sampling: {
        type: 'ratio',
        rate: 1,
      },
    },
  },
  memory: new Memory({
    storage: new LibSQLStore({
      id: 'libsql-storage',
      // DATABASE_URL 環境変数（file:./mastra.dbなど）があればそれを使用し、なければデフォルトのパスを使用します
      url: process.env.DATABASE_URL || 'file:/app/agent.db',
    }),
  }),
});
