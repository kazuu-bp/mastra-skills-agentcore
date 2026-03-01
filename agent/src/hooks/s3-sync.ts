import { S3Client } from '@aws-sdk/client-s3';
import S3SyncClientModule from 's3-sync-client';
import { mkdir, readdir } from 'fs/promises';
import { join } from 'path';
const s3Client = new S3Client({});
const S3SyncClient = (S3SyncClientModule as any).default || S3SyncClientModule;
const { sync } = new S3SyncClient({ client: s3Client });

const BUCKET_NAME = process.env.SKILLS_BUCKET_NAME || '';
const WORKSPACE_PATH = process.env.WORKSPACE_PATH || './workspace/';
const WORKSPACE_PATH_OUTPUTS = `${WORKSPACE_PATH}/.agents/outputs/`;


/**
 * S3からローカルworkspaceにファイルをDLする
 * invoke前に呼び出す
 */
export async function syncFromS3(): Promise<void> {
  if (!BUCKET_NAME) {
    console.log('[s3-sync] SKILLS_BUCKET_NAME が未設定のためスキップ');
    return;
  }

  console.log(`[s3-sync] S3 → ローカル同期開始 (bucket: ${BUCKET_NAME})`);
  try {
    // ワークスペースディレクトリが存在しない場合は作成
    await mkdir(WORKSPACE_PATH, { recursive: true });

    // s3://BUCKET/workspace/ -> ./workspace/ への同期
    await sync(`s3://${BUCKET_NAME}/workspace/`, WORKSPACE_PATH, { del: false });

    console.log(`[s3-sync] S3 → ローカル同期完了`);

    // 同期後にワークスペースの状態をログ出力
    const entries = await readdir(WORKSPACE_PATH, { recursive: true, withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => join((e as any).parentPath || (e as any).path || '', e.name));
    const fileCount = entries.filter((e) => e.isFile()).length;
    console.log(`[s3-sync] ${WORKSPACE_PATH} 以下: ディレクトリ ${dirs.length}個, ファイル ${fileCount}個`);
    console.log(`[s3-sync] ディレクトリ一覧:\n`, dirs);

  } catch (error) {
    console.error('[s3-sync] S3 → ローカル同期エラー:', error);
  }
}

/**
 * ローカルworkspaceの変更ファイルをS3にUPする
 * invoke後に呼び出す
 */
export async function syncToS3(): Promise<void> {
  if (!BUCKET_NAME) {
    console.log('[s3-sync] SKILLS_BUCKET_NAME が未設定のためスキップ');
    return;
  }

  console.log(`[s3-sync] ローカル → S3 同期開始 (bucket: ${BUCKET_NAME})`);
  try {
    // 同期元のディレクトリが存在しない場合は作成しておく（ENOENTエラー回避）
    await mkdir(WORKSPACE_PATH_OUTPUTS, { recursive: true });

    // ./workspace/.agents/outputs/ -> s3://BUCKET/workspace/.agents/outputs/ への同期
    await sync(`${WORKSPACE_PATH_OUTPUTS}`, `s3://${BUCKET_NAME}/workspace/.agents/outputs/`, { del: false });

    console.log(`[s3-sync] ローカル → S3 同期完了`);
  } catch (error) {
    console.error('[s3-sync] ローカル → S3 同期エラー:', error);
  }
}
