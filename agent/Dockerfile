# ========================================
# マルチステージビルド: Mastra AgentCore
# ========================================

# --- ステージ1: 依存関係インストールとビルド確認 ---
FROM node:22-slim AS builder

WORKDIR /app

# 依存関係ファイルをコピーしてインストール
COPY package*.json ./
RUN npm ci

# ソースコードとTypeScript設定をコピー
COPY src/ ./src/
COPY tsconfig.json ./

# --- ステージ2: 本番用イメージ ---
FROM node:22-slim AS production

WORKDIR /app

# Python3 と pip、および実行に必要なパッケージをインストール
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# python3 を python としても使えるようにシンボリックリンクを作成
RUN ln -sf /usr/bin/python3 /usr/local/bin/python

# 本番用依存関係のみインストール
COPY package*.json ./
RUN npm ci --omit=dev && npm install tsx

# ビルダーステージからソースコードをコピー
COPY --from=builder /app/src/ ./src/
COPY --from=builder /app/tsconfig.json ./

# AgentCore Runtime はポート8080を使用
EXPOSE 8080

# AgentCore サーバーを起動
CMD ["npx", "tsx", "src/agentcore.ts"]
