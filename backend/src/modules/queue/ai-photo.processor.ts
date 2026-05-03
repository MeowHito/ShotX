import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { PhotoAiJob } from './ai-queue.service';

@Processor('ai-photos')
@Injectable()
export class AiPhotoProcessor extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async process(job: Job<PhotoAiJob>) {
    const startedAt = Date.now();
    const { photoId, eventId, storageKey } = job.data;

    await this.prisma.photo.update({ where: { id: photoId }, data: { aiStatus: 'processing' } });

    try {
      const image = await this.storage.getObject(storageKey);
      const embeddings = await this.embedImage(image);

      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`DELETE FROM photo_faces WHERE photo_id = ${photoId}::uuid`);

        for (const embedding of embeddings) {
          const normalized = this.normalizeEmbedding(embedding);
          if (!normalized) continue;
          const vector = `[${normalized.join(',')}]`;
          await tx.$executeRaw(Prisma.sql`
            INSERT INTO photo_faces (photo_id, event_id, embedding, detection_score)
            VALUES (${photoId}::uuid, ${eventId}::uuid, ${vector}::vector, 1)
          `);
        }

        await tx.photo.update({
          where: { id: photoId },
          data: {
            aiStatus: 'done',
            faceCount: embeddings.length,
            processedAt: new Date(),
            aiError: null,
          },
        });
      });

      return { photoId, faceCount: embeddings.length, processingMs: Date.now() - startedAt };
    } catch (error) {
      await this.prisma.photo.update({
        where: { id: photoId },
        data: {
          aiStatus: 'failed',
          aiError: error instanceof Error ? error.message : 'ai_processing_failed',
        },
      });
      throw error;
    }
  }

  private async embedImage(image: Buffer) {
    const workerUrl = this.config.get<string>('WORKER_API_URL')?.replace(/\/$/, '');
    if (!workerUrl) throw new InternalServerErrorException('worker_url_not_configured');

    const form = new FormData();
    const bytes = new Uint8Array(image);
    form.append('selfie', new Blob([bytes], { type: 'image/jpeg' }), 'photo.jpg');

    const response = await fetch(`${workerUrl}/embed`, { method: 'POST', body: form });
    if (!response.ok) throw new InternalServerErrorException('worker_embed_failed');

    const payload = (await response.json()) as { embeddings?: number[][] };
    return payload.embeddings ?? [];
  }

  private normalizeEmbedding(embedding: number[]) {
    if (embedding.length !== 512) return null;
    const norm = Math.sqrt(embedding.reduce((sum, value) => sum + value * value, 0));
    if (!Number.isFinite(norm) || norm <= 0) return null;
    return embedding.map((value) => value / norm);
  }
}
