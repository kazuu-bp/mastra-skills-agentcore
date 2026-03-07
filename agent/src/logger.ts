import { pino } from 'pino';

// CloudWatchなどのログ出力向けにpinoロガーをエクスポートする
export const logger = pino({
  name: 'agentcore',
  level: process.env.LOG_LEVEL || 'info',
  // 同期・バッファなし出力が必要であれば以下のように設定可能ですが、
  // pino() のデフォルト出力(stdoutへの非同期/同期出力)で通常問題ありません。
  // destination: pino.destination({ dest: process.stderr.fd, sync: true })
});
