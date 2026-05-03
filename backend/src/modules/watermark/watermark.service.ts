import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class WatermarkService {
  constructor(private readonly prisma: PrismaService) {}

  get(photographerId: string) {
    return this.prisma.watermarkConfig.findUnique({ where: { photographerId } });
  }

  upsert(photographerId: string, data: { enabled?: boolean; text?: string; position?: string; size?: string; opacity?: number }) {
    return this.prisma.watermarkConfig.upsert({
      where: { photographerId },
      create: { photographerId, text: data.text ?? '', enabled: data.enabled ?? true, position: data.position ?? 'bot-right', size: data.size ?? 'M', opacity: data.opacity ?? 70 },
      update: data,
    });
  }
}
