import { Injectable, Logger } from '@nestjs/common';
import * as Minio from 'minio';
import { Readable } from 'node:stream';
import { config } from '../config';

/** Evidence object storage (S3/MinIO): raw HTML/JSON, uploaded documents, generated reports. */
@Injectable()
export class StorageService {
  private readonly log = new Logger('Storage');
  private readonly client = new Minio.Client({
    endPoint: config.minio.endPoint,
    port: config.minio.port,
    useSSL: config.minio.useSSL,
    accessKey: config.minio.accessKey,
    secretKey: config.minio.secretKey,
  });
  private ready = false;

  async ensureBucket(): Promise<void> {
    for (let attempt = 1; attempt <= 30; attempt++) {
      try {
        if (!(await this.client.bucketExists(config.minio.bucket))) {
          await this.client.makeBucket(config.minio.bucket);
        }
        this.ready = true;
        return;
      } catch (e) {
        this.log.warn(`MinIO not ready (${attempt}/30): ${e.message}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    throw new Error('MinIO unavailable');
  }

  async put(key: string, body: Buffer, contentType: string): Promise<string> {
    if (!this.ready) await this.ensureBucket();
    await this.client.putObject(config.minio.bucket, key, body, body.length, { 'Content-Type': contentType });
    return `s3://${config.minio.bucket}/${key}`;
  }

  private keyOf(ref: string): string {
    return ref.replace(`s3://${config.minio.bucket}/`, '');
  }

  async get(ref: string): Promise<Readable> {
    return this.client.getObject(config.minio.bucket, this.keyOf(ref));
  }

  async getBuffer(ref: string): Promise<Buffer> {
    const stream = await this.get(ref);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
  }

  async removePrefix(prefix: string): Promise<void> {
    const names: string[] = [];
    const stream = this.client.listObjectsV2(config.minio.bucket, prefix, true);
    for await (const obj of stream as AsyncIterable<{ name?: string }>) if (obj.name) names.push(obj.name);
    if (names.length) await this.client.removeObjects(config.minio.bucket, names);
  }
}
