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
