import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { serviceUrl } from '@uboce/common';

import { env } from '../config.js';

const client = (endpoint: string) =>
  new S3Client({
    endpoint,
    region: env.S3_REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
    // Signed upload URLs are created before the file exists, so a checksum
    // computed at signing time can never match; integrity is verified with
    // SHA-256 on completion instead.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

/** Private object storage. Clients only ever get short-lived signed links (PRD 5.17). */
@Injectable()
export class Storage implements OnApplicationBootstrap {
  private readonly logger = new Logger(Storage.name);
  private readonly internal = client(serviceUrl(env.S3_ENDPOINT));
  /** Signs URLs with the host clients can reach (differs from the internal one in containers). */
  private readonly signer = client(serviceUrl(env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT));

  async onApplicationBootstrap() {
    try {
      await this.internal.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
    } catch {
      await this.internal.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }));
      this.logger.log(`Created bucket ${env.S3_BUCKET}`);
    }
  }

  uploadUrl(key: string, contentType: string) {
    return getSignedUrl(this.signer, new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, ContentType: contentType }), {
      expiresIn: env.LINK_TTL_SECONDS,
    });
  }

  downloadUrl(key: string, fileName: string, contentType: string) {
    return getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key,
        ResponseContentType: contentType,
        ResponseContentDisposition: `attachment; filename="${fileName}"`,
      }),
      { expiresIn: env.LINK_TTL_SECONDS },
    );
  }

  /** Size, SHA-256 and the first bytes of a stored object, or null if nothing was uploaded. */
  async inspect(key: string): Promise<{ size: number; sha256: string; head: Buffer } | null> {
    try {
      await this.internal.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    } catch {
      return null;
    }
    const object = await this.internal.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    const hash = createHash('sha256');
    let size = 0;
    const head: Buffer[] = [];
    for await (const chunk of object.Body as Readable) {
      const buffer = chunk as Buffer;
      if (size < 16) head.push(buffer.subarray(0, 16 - size));
      size += buffer.length;
      hash.update(buffer);
    }
    return { size, sha256: hash.digest('hex'), head: Buffer.concat(head) };
  }

  async remove(key: string) {
    await this.internal.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
  }

  async ping() {
    await this.internal.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
  }
}
