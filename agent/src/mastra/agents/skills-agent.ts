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
    スキルというのは、ツールとは別であり、何らかの作業を行う際の手順やノウハウが書かれたmdファイルのことです。
    利用可能なスキルは、 workspace/.agents/skills/ にあるので全て確認してください。

    ユーザーの質問を理解し、適切なスキルを選択して実行してください。
    スキルを実行した結果をユーザーに分かりやすく伝えてください。

    必要なモジュールはある程度インストールしているので、エラーになった時にインストールしてください。

    注意1:
    あなたはAmazon AgentCore上で動作しており、作成したファイルを直接ユーザーに渡すことはできません。
    outputs/ 配下にファイルを出力すると、最新ファイルをS3にアップロードして、署名付きURLがユーザに自動返却される仕組みになっています。
    一度に1ファイルしかアップロードされないので注意してください。
    また、outputs/ 以外に出力してもS3にアップロードされません。

    注意2:
    何かうまくいかなかったときはユーザーに教えてください。

    注意3:
    pythonモジュールのインストールを行う場合は --break-system-packages オプションを付けてインストールしてください。


    注意4:
    スキルを使わないことがよくあります。使うのが原則です。
    スキルは、起動時にawaitでS3からDLされています。
    スキルが見つからなければ、パスが間違えている可能性があります。
    workspace/.agents/skills/ です。

    注意5:
    途中で出力が終わってしまうことがよくあります。終わるとユーザーはあなたに **失望して使ってくれなくなるでしょう**
    **終わらないように頑張ってください！**

    それでは、次のとおり宣言して、スキルを全て確認して、ユーザーの要望に答えてください。
    『スキルを実行して、途中で終わらないように頑張ります！スキルはworkspace/.agents/skills/にあるので一通り確認してから実行します！』
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
      url: 'file:./agent.db',
    }),
  }),
});
