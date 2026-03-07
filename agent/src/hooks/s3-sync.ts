import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import S3SyncClientModule from 's3-sync-client';
import { mkdir, readdir, readFile, stat } from 'fs/promises';

import { join, relative } from 'path';
import { logger } from '../logger.js';

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
    logger.info('[s3-sync] SKILLS_BUCKET_NAME が未設定のためスキップ');
    return;
  }

  // skillsフォルダが既に存在する場合はS3からの同期をスキップする
  const skillsDir = join(WORKSPACE_PATH, '.agents', 'skills');
  try {
    const s = await stat(skillsDir);
    if (s.isDirectory()) {
      logger.info(`[s3-sync] skillsフォルダ (${skillsDir}) が既に存在するため、S3からの同期をスキップします`);
      return;
    }
  } catch (err: any) {
    // 存在しない場合はそのまま同期を実行
  }

  logger.info({ bucket: BUCKET_NAME }, '[s3-sync] S3 → ローカル同期開始');
  try {
    // ワークスペースディレクトリが存在しない場合は作成
    await mkdir(WORKSPACE_PATH, { recursive: true });

    // s3://BUCKET/workspace/ -> ./workspace/ への同期
    await sync(`s3://${BUCKET_NAME}/workspace/`, WORKSPACE_PATH, { del: false });

    logger.info('[s3-sync] S3 → ローカル同期完了');

    // 同期後にワークスペースの状態をログ出力
    const entries = await readdir(WORKSPACE_PATH, { recursive: true, withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => join((e as any).parentPath || (e as any).path || '', e.name));
    const fileCount = entries.filter((e) => e.isFile()).length;
    logger.info({ directoryCount: dirs.length, fileCount }, `[s3-sync] ${WORKSPACE_PATH} 以下`);
    logger.info({ dirs }, '[s3-sync] ディレクトリ一覧:');

  } catch (error) {
    logger.error({ err: error }, '[s3-sync] S3 → ローカル同期エラー:');
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
    logger.info('[s3-sync] SKILLS_BUCKET_NAME が未設定のためスキップ');
    return null;
  }

  logger.info({ bucket: BUCKET_NAME }, '[s3-sync] outputs → S3 アップロード開始');

  let url: string | null = null;

  try {
    // outputs ディレクトリが存在しない場合はスキップ（エラーなし）
    let entries: import('fs').Dirent[];
    try {
      entries = await readdir(WORKSPACE_PATH_OUTPUTS, { recursive: true, withFileTypes: true });
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        logger.info('[s3-sync] outputs ディレクトリが存在しないためスキップ');
        return null;
      }
      logger.error({ err: error }, '[s3-sync] outputs ディレクトリ読み取りエラー:');
      return null;
    }

    // ファイルのみ抽出
    const fileEntries = entries.filter((e) => e.isFile());

    // アップロード前にoutputsディレクトリの状態をログ出力（syncFromS3と同様）
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => join((e as any).parentPath || (e as any).path || '', e.name));
    logger.info({ directoryCount: dirs.length, fileCount: fileEntries.length }, `[s3-sync] ${WORKSPACE_PATH_OUTPUTS} 以下`);
    if (dirs.length > 0) logger.info({ dirs }, '[s3-sync] ディレクトリ一覧:');
    logger.info({ files: fileEntries.map((e) => join((e as any).parentPath ?? (e as any).path ?? WORKSPACE_PATH_OUTPUTS, e.name)) }, '[s3-sync] ファイル一覧:');

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
      logger.info({ localPath: newest.localPath, mtime: new Date(newest.mtimeMs).toISOString() }, '[s3-sync] 最新ファイル');

      // 過去にアップロードしたファイルと同じか古い場合はスキップ
      if (newest.mtimeMs <= lastUploadedMtime) {
        logger.info('[s3-sync] 最新ファイルは既にアップロード済みのためスキップします。');
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
      logger.info({ s3Key }, '[s3-sync] アップロード完了');

      // GenU上で署名付きURLを再取得しに行くのでURLをそのまま返す
      url = `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3Key}`;

      lastUploadedMtime = newest.mtimeMs;
    } else {
      logger.info('[s3-sync] アップロード対象ファイルなし');
    }
  } catch (error) {
    logger.error({ err: error }, '[s3-sync] アップロード処理エラー:');
  }

  return url;
}
