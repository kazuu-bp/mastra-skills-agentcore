# ========================================
# Mastra AgentCore: サンプルDockerfileに合わせたビルド方式
# npm run build:agentcore (tsc) でビルドし、node で直接実行
# ========================================

FROM public.ecr.aws/docker/library/node:22-slim

WORKDIR /app


ENV DOCKER_CONTAINER=1 \
    AWS_REGION=ap-northeast-1 \
    AWS_DEFAULT_REGION=ap-northeast-1

# Python3 と pip、および実行に必要なパッケージをインストール
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# 日本語フォントのインストール
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-takao fonts-takao-gothic fonts-takao-mincho \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# python3 を python としても使えるようにシンボリックリンクを作成
RUN ln -sf /usr/bin/python3 /usr/local/bin/python

# 作業ディレクトリとキャッシュディレクトリの権限をあらかじめ node ユーザーに付与
RUN mkdir -p /app /home/node/.npm && chown -R node:node /app /home/node

# 以降の作業はすべて node ユーザーで実行する
USER node

# npxのインタラクティブな確認プロンプトをスキップし、キャッシュディレクトリの権限を確保
ENV NPM_CONFIG_YES=true \
    NPM_CONFIG_CACHE=/home/node/.npm

# ソースコードを node ユーザー権限でコピー
COPY --chown=node:node . .

# 全依存関係インストール（devDependencies含む: tsc, tsx など）
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# TypeScript を JS にビルド (dist/ に出力)
RUN npm run build:agentcore

# devDependencies を削除して本番モードに
RUN npm prune --production
ENV NODE_ENV=production

# otel auto-instrumentations を追加
RUN npm install @opentelemetry/auto-instrumentations-node

# slidev, marpに必要なモジュールをインストール
RUN npm install @slidev/cli @marp-team/marp-cli playwright

# AgentCore Runtime はポート8080を使用
EXPOSE 9000
EXPOSE 8000
EXPOSE 8080

ENV MODEL=jp.anthropic.claude-sonnet-4-5-20250929-v1:0


# ビルド済み JS を node で直接実行
CMD ["node", "--require", "@opentelemetry/auto-instrumentations-node/register", "dist/agentcore.js", "--trace-warnings"]
