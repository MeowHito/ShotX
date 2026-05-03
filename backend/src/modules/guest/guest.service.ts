import { BadRequestException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import sharp from 'sharp';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

@Injectable()
export class GuestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly storage: StorageService,
  ) {}

  async downloadPhoto(slug: string, photoId: string, sessionId: string | undefined, ip: string | undefined) {
    const event = await this.prisma.event.findUnique({ where: { slug } });
    if (!event || event.status !== 'active') throw new NotFoundException('event_not_found');
    const photo = await this.prisma.photo.findFirst({ where: { id: photoId, eventId: event.id } });
    if (!photo) throw new NotFoundException('photo_not_found');

    const watermark = await this.prisma.watermarkConfig.findFirst({
      where: { photographer: { events: { some: { id: event.id } } } },
    });

    const key = this.storage.keyFromUrl(photo.fileUrl);
    if (!key) throw new InternalServerErrorException('photo_key_not_found');
    const original = await this.storage.getObject(key);

    let buffer: Buffer = original;
    if (watermark?.enabled) {
      const stamped = await this.applyWatermark(original, watermark.text, watermark.opacity, watermark.position);
      buffer = Buffer.from(stamped);
    }

    await this.prisma.download.create({
      data: {
        photoId: photo.id,
        eventId: event.id,
        sessionId,
        ipAddress: ip,
        watermarkText: watermark?.enabled ? watermark.text : null,
      },
    });
    await this.prisma.event.update({ where: { id: event.id }, data: { totalDownloads: { increment: 1 } } });

    return { buffer, filename: photo.filename, contentType: 'image/jpeg' };
  }

  private async applyWatermark(image: Buffer, text: string, opacity: number, position: string) {
    const meta = await sharp(image).metadata();
    const width = meta.width ?? 1024;
    const fontSize = Math.max(18, Math.round(width / 30));
    const padding = Math.round(fontSize * 0.6);
    const safeText = (text || 'ShotX').replace(/[<&>"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]!));
    const opacityFloat = Math.max(0, Math.min(1, opacity / 100));
    const svg = `<svg width="${width}" height="${fontSize + padding * 2}" xmlns="http://www.w3.org/2000/svg">
      <style>.t { font: bold ${fontSize}px sans-serif; fill: white; opacity: ${opacityFloat}; paint-order: stroke; stroke: rgba(0,0,0,.55); stroke-width: 2px; }</style>
      <text class="t" x="${width - padding}" y="${fontSize + padding / 2}" text-anchor="end">${safeText}</text>
    </svg>`;
    const gravity = position === 'top-left' ? 'northwest' : position === 'top-right' ? 'northeast' : position === 'bot-left' ? 'southwest' : 'southeast';
    return sharp(image)
      .composite([{ input: Buffer.from(svg), gravity }])
      .jpeg({ quality: 90 })
      .toBuffer();
  }

  async getEvent(slug: string) {
    const event = await this.prisma.event.findUnique({
      where: { slug },
      include: { photographer: { select: { name: true } } },
    });
    if (!event || event.status !== 'active') throw new NotFoundException('event_not_found');
    return {
      id: event.id,
      name: event.name,
      event_date: event.eventDate,
      venue: event.venue,
      photo_count: event.photoCount,
      photographer_name: event.photographer.name,
      status: event.status,
    };
  }

  async listPhotos(slug: string) {
    const event = await this.prisma.event.findUnique({ where: { slug } });
    if (!event) throw new NotFoundException('event_not_found');
    const photos = await this.prisma.photo.findMany({ where: { eventId: event.id, aiStatus: 'done' }, take: 50, orderBy: { createdAt: 'desc' } });
    return { photos, total: photos.length, page: 1 };
  }

  async searchByFace(slug: string, selfie?: Express.Multer.File, sessionId?: string) {
    const startedAt = Date.now();
    const event = await this.prisma.event.findUnique({ where: { slug } });
    if (!event) throw new NotFoundException('event_not_found');

    if (!selfie) throw new BadRequestException('selfie_required');
    if (!selfie.mimetype.startsWith('image/')) throw new BadRequestException('selfie_must_be_image');

    const embedding = await this.embedSelfie(selfie);
    if (!embedding) throw new BadRequestException('no_face_detected');

    const threshold = Number(this.config.get<string>('FACE_SEARCH_THRESHOLD') ?? '0.55');
    const limit = Number(this.config.get<string>('FACE_SEARCH_LIMIT') ?? '50');
    const candidateLimit = Math.max(limit * 8, 200);
    const vector = `[${embedding.join(',')}]`;
    const rows = await this.prisma.$queryRaw<Array<{ photo_id: string; similarity: number; rank: bigint }>>(Prisma.sql`
      WITH nearest_faces AS (
        SELECT pf.photo_id, 1 - (pf.embedding <=> ${vector}::vector) AS similarity
        FROM photo_faces pf
        WHERE pf.event_id = ${event.id}::uuid
        ORDER BY pf.embedding <=> ${vector}::vector
        LIMIT ${candidateLimit}
      ), ranked AS (
        SELECT photo_id, MAX(similarity) AS similarity
        FROM nearest_faces
        GROUP BY photo_id
      )
      SELECT photo_id, similarity, ROW_NUMBER() OVER (ORDER BY similarity DESC) AS rank
      FROM ranked
      WHERE similarity >= ${threshold}
      ORDER BY similarity DESC
      LIMIT ${limit}
    `);

    const search = await this.prisma.guestSearch.create({
      data: {
        eventId: event.id,
        matchedCount: rows.length,
        searchLatencyMs: Date.now() - startedAt,
        sessionId,
      },
    });

    if (rows.length > 0) {
      await this.prisma.searchResult.createMany({
        data: rows.map((row) => ({
          searchId: search.id,
          photoId: row.photo_id,
          similarity: Number(row.similarity),
          rank: Number(row.rank),
        })),
      });
    }

    await this.prisma.event.update({ where: { id: event.id }, data: { totalSearches: { increment: 1 } } });

    const photos = rows.length
      ? await this.prisma.photo.findMany({
          where: { id: { in: rows.map((row) => row.photo_id) } },
          select: {
            id: true,
            filename: true,
            thumbnailUrl: true,
            fileUrl: true,
            width: true,
            height: true,
            faceCount: true,
          },
        })
      : [];
    const photosById = new Map(photos.map((photo) => [photo.id, photo]));

    return {
      search_id: search.id,
      matched_count: rows.length,
      latency_ms: search.searchLatencyMs,
      threshold,
      photos: rows.flatMap((row) => {
        const photo = photosById.get(row.photo_id);
        if (!photo) return [];
        return [{ ...photo, similarity: Number(row.similarity), rank: Number(row.rank) }];
      }),
    };
  }

  private async embedSelfie(selfie: Express.Multer.File) {
    const workerUrl = this.config.get<string>('WORKER_API_URL')?.replace(/\/$/, '');
    if (!workerUrl) throw new InternalServerErrorException('worker_url_not_configured');

    const form = new FormData();
    const bytes = new Uint8Array(selfie.buffer);
    form.append('selfie', new Blob([bytes], { type: selfie.mimetype }), selfie.originalname || 'selfie.jpg');

    const response = await fetch(`${workerUrl}/embed`, { method: 'POST', body: form });
    if (!response.ok) throw new InternalServerErrorException('worker_embed_failed');

    const payload = (await response.json()) as { embeddings?: number[][] };
    const embedding = payload.embeddings?.[0];
    if (!embedding || embedding.length !== 512) return null;

    const norm = Math.sqrt(embedding.reduce((sum, value) => sum + value * value, 0));
    if (!Number.isFinite(norm) || norm <= 0) return null;
    return embedding.map((value) => value / norm);
  }
}
