import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import S3SyncClientModule from 's3-sync-client';
import { mkdir, readdir, readFile, stat, writeFile } from 'fs/promises';

import { join, relative } from 'path';
import { logger } from '../logger.js';

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'ap-northeast-1',
});
const S3SyncClient = (S3SyncClientModule as any).default || S3SyncClientModule;
const { sync } = new S3SyncClient({ client: s3Client });

const BUCKET_NAME = process.env.SKILLS_BUCKET_NAME || '';
const WORKSPACE_PATH = (process.env.WORKSPACE_PATH || '/app/workspace').replace(/\/$/, '');
const WORKSPACE_PATH_OUTPUTS = `${WORKSPACE_PATH}/outputs/`;

// agent.db のローカルパスと S3 キー
const AGENT_DB_LOCAL_PATH = process.env.AGENT_DB_PATH || '/app/agent.db';
const AGENT_DB_S3_KEY = 'agent.db';

/** 最後にアップロードしたファイルの更新時間 */
let lastUploadedMtime = 0;

/**
 * S3 から agent.db をダウンロードする
 * ファイルが S3 に存在しない場合はスキップ（初回起動時など）
 */
async function downloadAgentDbFromS3(): Promise<void> {
  try {
    logger.info({ s3Key: AGENT_DB_S3_KEY, localPath: AGENT_DB_LOCAL_PATH }, '[s3-sync] agent.db S3 → ローカル ダウンロード開始');
    const res = await s3Client.send(new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: AGENT_DB_S3_KEY,
    }));

    // ストリームをバッファに変換して書き出す
    const chunks: Uint8Array[] = [];
    for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    await writeFile(AGENT_DB_LOCAL_PATH, buffer);
    logger.info({ localPath: AGENT_DB_LOCAL_PATH, bytes: buffer.length }, '[s3-sync] agent.db ダウンロード完了');
  } catch (err: any) {
    if (err?.name === 'NoSuchKey' || err?.Code === 'NoSuchKey') {
      // 初回起動時など S3 に未登録の場合は正常スキップ
      logger.info('[s3-sync] agent.db が S3 に存在しないため初回起動とみなしスキップ');
    } else {
      logger.warn({ err }, '[s3-sync] agent.db ダウンロードエラー（処理は継続）');
    }
  }
}

/**
 * 起動時専用: S3 から agent.db をダウンロードする（agentcore.ts の initMastra() から呼ぶ）
 * mastra の動的 import より前に呼び出すことで、LibSQLStore が正しい DB を開けるようにする
 */
export async function downloadAgentDbOnStartup(): Promise<void> {
  await downloadAgentDbFromS3();
}

/**
 * ローカルの agent.db を S3 にアップロードする
 * ファイルが存在しない場合はスキップ
 */
async function uploadAgentDbToS3(): Promise<void> {
  try {
    await stat(AGENT_DB_LOCAL_PATH);
  } catch {
    logger.info('[s3-sync] agent.db がローカルに存在しないためアップロードをスキップ');
    return;
  }

  try {
    logger.info({ localPath: AGENT_DB_LOCAL_PATH, s3Key: AGENT_DB_S3_KEY }, '[s3-sync] agent.db ローカル → S3 アップロード開始');
    const body = await readFile(AGENT_DB_LOCAL_PATH);
    await s3Client.send(new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: AGENT_DB_S3_KEY,
      Body: body,
      ContentType: 'application/x-sqlite3',
    }));
    logger.info({ s3Key: AGENT_DB_S3_KEY, bytes: body.length }, '[s3-sync] agent.db アップロード完了');
  } catch (err) {
    logger.error({ err }, '[s3-sync] agent.db アップロードエラー');
  }
}

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

    // s3://BUCKET/workspace/skills/ -> /app/workspace/skills/ への同期
    await sync(`s3://${BUCKET_NAME}/workspace/skills/`, `${WORKSPACE_PATH}/skills/`, {
      del: false,
      relocations: [
        (currentPath: string) => currentPath.startsWith('workspace/skills/') ? currentPath.substring('workspace/skills/'.length) : currentPath
      ]
    });

    logger.info('[s3-sync] S3 → ローカル同期完了');

    // /app/workspace/outputs ディレクトリを作成
    await mkdir(WORKSPACE_PATH_OUTPUTS, { recursive: true });

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
 * workspace/outputs にある最新ファイルを S3 にアップロードし、アップロードしたバケット名とs3keyを返す
 * Agentのinvoke後に呼び出される
 *
 * 複数回のやり取りで outputs に複数ファイルが溜まった場合は
 * 更新日時が最も新しいファイルのみを対象とする。
 *
 * @returns BucketName、S3Key
 */
export async function syncToS3(): Promise<{ bucketName: string; s3Key: string } | null> {
  if (!BUCKET_NAME) {
    logger.info('[s3-sync] SKILLS_BUCKET_NAME が未設定のためスキップ');
    return null;
  }

  logger.info({ bucket: BUCKET_NAME }, '[s3-sync] outputs → S3 アップロード開始');

  let resultInfo: { bucketName: string; s3Key: string } | null = null;

  try {
    // outputs ディレクトリが存在しない場合はスキップ（エラーなし）
    let entries: import('fs').Dirent[];
    try {
      entries = await readdir(WORKSPACE_PATH_OUTPUTS, { recursive: true, withFileTypes: true });
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        logger.info('[s3-sync] outputs ディレクトリが存在しないためスキップ');
        // outputs がなくても agent.db はアップロードする
        await uploadAgentDbToS3();
        return null;
      }
      logger.error({ err: error }, '[s3-sync] outputs ディレクトリ読み取りエラー:');
      await uploadAgentDbToS3();
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
      } else {
        const s3Key = `workspace/outputs/${relative(WORKSPACE_PATH_OUTPUTS, newest.localPath)}`;

        // ファイルを読み込んでアップロード
        const body = await readFile(newest.localPath);
        await s3Client.send(new PutObjectCommand({
          Bucket: BUCKET_NAME,
          Key: s3Key,
          Body: body,
        }));
        logger.info({ s3Key }, '[s3-sync] アップロード完了');

        resultInfo = { bucketName: BUCKET_NAME, s3Key: s3Key };
        lastUploadedMtime = newest.mtimeMs;
      }
    } else {
      logger.info('[s3-sync] アップロード対象ファイルなし');
    }
  } catch (error) {
    logger.error({ err: error }, '[s3-sync] アップロード処理エラー:');
  }

  // outputs の処理の成否に関わらず agent.db を常にアップロード
  await uploadAgentDbToS3();

  return resultInfo;
}
