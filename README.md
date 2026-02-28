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

`cdk deploy` 完了後に出力される `RuntimeArn` を使って直接呼び出せます。

### エンドポイントの呼び出し


```shell
# ARNを環境変数に設定
export RUNTIME_ARN=<cdk deployで出力されたRuntimeArn>

# テスト実行
npm run test:invoke

# プロンプトを引数で指定
npx tsx test-invoke.mts "大阪の今日の天気は?"
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
