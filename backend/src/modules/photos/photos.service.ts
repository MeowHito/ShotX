import { Injectable, NotFoundException } from '@nestjs/common';
import sharp from 'sharp';
import { AiQueueService } from '../queue/ai-queue.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

@Injectable()
export class PhotosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly aiQueue: AiQueueService,
  ) {}

  async list(eventId: string) {
    return this.prisma.photo.findMany({
      where: { eventId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        filename: true,
        thumbnailUrl: true,
        fileSizeBytes: true,
        width: true,
        height: true,
        mimeType: true,
        aiStatus: true,
        faceCount: true,
        createdAt: true,
      },
    });
  }

  async upload(photographerId: string, eventId: string, files: Express.Multer.File[]) {
    const event = await this.prisma.event.findFirst({ where: { id: eventId, photographerId } });
    if (!event) throw new NotFoundException('event_not_found');

    const jobs: Array<{ photo_id: string; filename: string; job_id?: string; queue_type: 'standard' }> = [];
    let totalBytes = 0n;

    await Promise.all(
      files.map(async (file) => {
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]+/g, '_');
        const baseKey = `${eventId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
        const originalKey = `originals/${baseKey}`;
        const thumbKey = `thumbs/${baseKey.replace(/\.[^.]+$/, '')}.webp`;

        let metaWidth: number | null = null;
        let metaHeight: number | null = null;
        let thumb: Buffer = file.buffer;
        try {
          const meta = await sharp(file.buffer, { failOn: 'none' }).rotate().metadata();
          metaWidth = meta.width ?? null;
          metaHeight = meta.height ?? null;
          const t = await sharp(file.buffer, { failOn: 'none' })
            .rotate()
            .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 78 })
            .toBuffer();
          thumb = Buffer.from(t);
        } catch {
          // fall back to original as thumbnail
        }

        const [original, thumbObj] = await Promise.all([
          this.storage.putObject(originalKey, file.buffer, file.mimetype),
          this.storage.putObject(thumbKey, thumb, thumb === file.buffer ? file.mimetype : 'image/webp'),
        ]);

        const photo = await this.prisma.photo.create({
          data: {
            eventId,
            filename: file.originalname,
            fileUrl: original.url,
            thumbnailUrl: thumbObj.url,
            fileSizeBytes: BigInt(file.size),
            width: metaWidth,
            height: metaHeight,
            mimeType: file.mimetype,
            queueType: 'standard',
          },
        });
        const queueJob = await this.aiQueue.enqueuePhoto({ photoId: photo.id, eventId, storageKey: originalKey, queueType: 'standard' });
        jobs.push({ photo_id: photo.id, filename: photo.filename, job_id: queueJob.id, queue_type: 'standard' });
        totalBytes += BigInt(file.size);
      }),
    );

    await this.prisma.event.update({ where: { id: eventId }, data: { photoCount: { increment: jobs.length } } });
    await this.prisma.photographer.update({ where: { id: photographerId }, data: { storageUsedBytes: { increment: totalBytes } } });

    return { uploaded: jobs.length, failed: files.length - jobs.length, jobs };
  }
}
