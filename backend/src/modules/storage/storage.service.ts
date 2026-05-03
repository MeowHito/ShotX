import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class StorageService {
  private readonly storageDir: string;
  private readonly publicUrl: string;

  constructor(private readonly config: ConfigService) {
    this.storageDir = resolve(this.config.get<string>('STORAGE_DIR') ?? join(process.cwd(), 'uploads'));
    this.publicUrl = (this.config.get<string>('STORAGE_PUBLIC_URL') ?? 'http://localhost:4000/uploads').replace(/\/$/, '');
  }

  async putObject(key: string, body: Buffer, contentType: string) {
    const filePath = this.pathForKey(key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, body);
    return { key, url: `${this.publicUrl}/${key}` };
  }

  async getObject(key: string) {
    return readFile(this.pathForKey(key));
  }

  async deleteObject(key: string) {
    await rm(this.pathForKey(key), { force: true });
  }

  signGetUrl(key: string, expiresInSeconds = 300) {
    return `${this.publicUrl}/${key}`;
  }

  keyFromUrl(url: string) {
    if (!url.startsWith(this.publicUrl)) return null;
    return url.slice(this.publicUrl.length + 1);
  }

  getRootDir() {
    return this.storageDir;
  }

  createReadStream(key: string) {
    return createReadStream(this.pathForKey(key));
  }

  private pathForKey(key: string) {
    const safeKey = normalize(key).replace(/^([/\\])+/, '');
    const filePath = resolve(this.storageDir, safeKey);
    if (filePath !== this.storageDir && !filePath.startsWith(`${this.storageDir}${sep}`)) throw new Error('invalid_storage_key');
    return filePath;
  }
}
