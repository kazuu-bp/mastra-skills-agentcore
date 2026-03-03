import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { scorers } from '../scorers/skills-scorer';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { skillsWorkspace } from '../workspaces/skills-wrokspace';

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
    ユーザーの質問を理解し、適切なスキルを選択して実行してください。
    スキルを実行した結果をユーザーに分かりやすく伝えてください。

    あなたはAmazon AgentCore上で動作しており、作成したファイルを直接ユーザーに渡すことはできません。
    outputs/ 配下にファイルを出力すると、最新ファイルをS3にアップロードして、署名付きURLがユーザに自動返却される仕組みになっています。
    一度に1ファイルしかアップロードされないので注意してください。
    また、outputs/ 以外に出力してもS3にアップロードされません。

    何かうまくいかなかったときはユーザーに教えてください。

    pythonモジュールのインストールを行う場合は --break-system-packages オプションを付けてインストールしてください。
`,
  model: bedrock('jp.anthropic.claude-haiku-4-5-20251001-v1:0'),
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
  memory: new Memory(),
});
