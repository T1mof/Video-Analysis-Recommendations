import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { env } from '../config/env.ts';

/**
 * S3-compatible object storage. MinIO locally, a managed bucket + CDN in
 * production - the code does not care which, which is the point of keeping it
 * behind this module.
 *
 * The API never streams video bytes itself. Clients receive a presigned URL and
 * fetch from storage directly; in production that URL is a CDN edge. This is what
 * keeps the Node process out of the media path at 3k RPS.
 */
export const s3 = new S3Client({
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
});

export const videoKey = (id: string): string => `videos/${id}.mp4`;
export const posterKey = (id: string): string => `thumbs/${id}.jpg`;

export async function putObject(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

/** Streams an object to a local file, for tools that need a real path (ffmpeg). */
export async function getObjectToFile(key: string, destinationPath: string): Promise<void> {
  const response = await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
  if (!response.Body) throw new Error(`Object ${key} has no body`);

  const body = response.Body as unknown as NodeJS.ReadableStream;
  await pipeline(body, createWriteStream(destinationPath));
}

export async function deleteObject(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
}

export async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/** Presigned GET URL. In production this is replaced by a CDN URL. */
export async function presignGet(
  key: string,
  ttlSeconds: number = env.MEDIA_URL_TTL_SECONDS,
): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }), {
    expiresIn: ttlSeconds,
  });
}
