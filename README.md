# mastra-skills-agentcore

AWS Bedrock AgentCore上で動作するMastraエージェント。天気エージェントをサンプルとして実装しており、CDKでワンコマンドデプロイできます。

## フォルダ構成

```
/
├── bin/app.ts                  # CDKエントリポイント
├── lib/agentcore-stack.ts      # CDKスタック（ECR + AgentCore Runtime + IAM）
├── mastra/                     # Mastraエージェント一式
│   ├── src/
│   │   ├── agentcore.ts        # AgentCore サーバー（エントリポイント）
│   │   └── mastra/
│   │       ├── index.ts        # Mastra インスタンス定義
│   │       ├── agents/         # エージェント定義
│   │       ├── tools/          # ツール定義
│   │       ├── workflows/      # ワークフロー定義
│   │       └── scorers/        # スコアラー定義
│   ├── Dockerfile              # コンテナイメージ定義（マルチステージビルド）
│   └── package.json            # Mastra依存関係
├── package.json                # CDK依存関係
├── cdk.json                    # CDK設定
└── tsconfig.json               # CDK TypeScript設定
```

## デプロイ

### 前提条件

- AWS CLI 設定済み（ `aws configure` または `aws login` ）
- CDK Bootstrap 済み（初回のみ）

```shell
# 初回のみ
npx cdk bootstrap
```

### デプロイ実行

```shell
npm run cdk:deploy
```

`--require-approval never` で確認なしにデプロイされます。

### その他のCDKコマンド

```shell
# テンプレート確認
npm run cdk:synth

# 削除
npm run cdk:destroy
```

## デプロイ済みエージェントのテスト

デプロイ後、AgentCore RuntimeのARNが出力されます。

### 1. AgentCore IDentity の取得

```shell
# Runtime ARN からエンドポイントURLを確認
aws bedrock-agentcore get-agent-runtime \
  --agent-runtime-id <RUNTIME_ID>
```

### 2. エンドポイントの呼び出し

```shell
aws bedrock-agentcore invoke-agent-runtime \
  --agent-runtime-id <RUNTIME_ID> \
  --payload '{"prompt": "東京の今日の天気は？"}' \
  --content-type application/json \
  output.txt && cat output.txt
```

## AgentCore サーバーのローカルテスト

```shell
# Mastraディレクトリに移動して起動
cd mastra && npm run dev:agentcore
```

別ターミナルからテスト:

```shell
curl -X POST http://127.0.0.1:8080/invocations \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"sessionId": "test-session-1", "prompt": "東京の明日の天気は？"}'
```

## Mastra Studio（開発用）

```shell
cd mastra && npm run dev
# http://localhost:4111 でUIが開きます
```
