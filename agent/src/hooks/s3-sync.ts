import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import S3SyncClientModule from 's3-sync-client';
import { mkdir, readdir, readFile, stat } from 'fs/promises';

import { join, relative } from 'path';

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'ap-northeast-1',
});
const S3SyncClient = (S3SyncClientModule as any).default || S3SyncClientModule;
const { sync } = new S3SyncClient({ client: s3Client });

const BUCKET_NAME = process.env.SKILLS_BUCKET_NAME || '';
const WORKSPACE_PATH = process.env.WORKSPACE_PATH || './workspace/';
const WORKSPACE_PATH_OUTPUTS = `${WORKSPACE_PATH}/outputs/`;

/** presignedURL の有効期限（秒） */
const PRESIGNED_URL_EXPIRES_IN = 180;

/** 最後にアップロードしたファイルの更新時間 */
let lastUploadedMtime = 0;

/**
 * S3からローカルworkspaceにファイルをDLする
 * invoke前に呼び出す
 */
export async function syncFromS3(): Promise<void> {
  if (!BUCKET_NAME) {
    console.log('[s3-sync] SKILLS_BUCKET_NAME が未設定のためスキップ');
    return;
  }

  // skillsフォルダが既に存在する場合はS3からの同期をスキップする
  const skillsDir = join(WORKSPACE_PATH, '.agents', 'skills');
  try {
    const s = await stat(skillsDir);
    if (s.isDirectory()) {
      console.log(`[s3-sync] skillsフォルダ (${skillsDir}) が既に存在するため、S3からの同期をスキップします`);
      return;
    }
  } catch (err: any) {
    // 存在しない場合はそのまま同期を実行
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
 * workspace/outputs にある最新ファイルを S3 にアップロードし、署名付きURL（3分）を返す
 * invoke後に呼び出す
 *
 * 複数回のやり取りで outputs に複数ファイルが溜まった場合は
 * 更新日時が最も新しいファイルのみを対象とする。
 *
 * @returns 最新ファイルの署名付きURL（ファイルがなければ null）
 */
export async function syncToS3(): Promise<string | null> {
  if (!BUCKET_NAME) {
    console.log('[s3-sync] SKILLS_BUCKET_NAME が未設定のためスキップ');
    return null;
  }

  console.log(`[s3-sync] outputs → S3 アップロード開始 (bucket: ${BUCKET_NAME})`);

  let url: string | null = null;

  try {
    // outputs ディレクトリが存在しない場合はスキップ（エラーなし）
    let entries: import('fs').Dirent[];
    try {
      entries = await readdir(WORKSPACE_PATH_OUTPUTS, { recursive: true, withFileTypes: true });
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        console.log('[s3-sync] outputs ディレクトリが存在しないためスキップ');
        return null;
      }
      console.error('[s3-sync] outputs ディレクトリ読み取りエラー:', error);
      return null;
    }

    // ファイルのみ抽出
    const fileEntries = entries.filter((e) => e.isFile());

    // アップロード前にoutputsディレクトリの状態をログ出力（syncFromS3と同様）
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => join((e as any).parentPath || (e as any).path || '', e.name));
    console.log(`[s3-sync] ${WORKSPACE_PATH_OUTPUTS} 以下: ディレクトリ ${dirs.length}個, ファイル ${fileEntries.length}個`);
    if (dirs.length > 0) console.log(`[s3-sync] ディレクトリ一覧:\n`, dirs);
    console.log(`[s3-sync] ファイル一覧:\n`, fileEntries.map((e) => join((e as any).parentPath ?? (e as any).path ?? WORKSPACE_PATH_OUTPUTS, e.name)));

    if (fileEntries.length > 0) {
      // stat を使って更新日時が最も新しいファイルを選択する
      // （複数回のやり取りで outputs に古いファイルが残っていても最新1件のみ対象）
      const fileStats = await Promise.all(
        fileEntries.map(async (e) => {
          const localPath = join((e as any).parentPath ?? (e as any).path ?? WORKSPACE_PATH_OUTPUTS, e.name);
          const s = await stat(localPath);
          return { localPath, mtimeMs: s.mtimeMs };
        }),
      );
      const newest = fileStats.reduce((a, b) => (a.mtimeMs >= b.mtimeMs ? a : b));
      console.log(`[s3-sync] 最新ファイル: ${newest.localPath} (mtime: ${new Date(newest.mtimeMs).toISOString()})`);

      // 過去にアップロードしたファイルと同じか古い場合はスキップ
      if (newest.mtimeMs <= lastUploadedMtime) {
        console.log(`[s3-sync] 最新ファイルは既にアップロード済みのためスキップします。`);
        return null;
      }

      const s3Key = `workspace/outputs/${relative(WORKSPACE_PATH_OUTPUTS, newest.localPath)}`;

      // ファイルを読み込んでアップロード
      const body = await readFile(newest.localPath);
      await s3Client.send(new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: s3Key,
        Body: body,
      }));
      console.log(`[s3-sync] アップロード完了: ${s3Key}`);

      // 署名付きURL（3分）を生成して返す
      url = await getSignedUrl(
        s3Client,
        new GetObjectCommand({ Bucket: BUCKET_NAME, Key: s3Key }),
        { expiresIn: PRESIGNED_URL_EXPIRES_IN },
      );

      lastUploadedMtime = newest.mtimeMs;
    } else {
      console.log('[s3-sync] アップロード対象ファイルなし');
    }
  } catch (error) {
    console.error(`[s3-sync] アップロード処理エラー:`, error);
  }

  return url;
}
