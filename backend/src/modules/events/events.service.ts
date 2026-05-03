import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateEventDto } from './dto';

@Injectable()
export class EventsService {
  constructor(private readonly prisma: PrismaService) {}

  list(photographerId: string) {
    return this.prisma.event.findMany({
      where: { photographerId, status: { not: 'deleted' } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        slug: true,
        photoCount: true,
        status: true,
        expiresAt: true,
        createdAt: true,
      },
    });
  }

  async create(photographerId: string, dto: CreateEventDto) {
    const slug = this.slugify(`${dto.name}-${Date.now()}`);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    return this.prisma.event.create({
      data: {
        photographerId,
        name: dto.name,
        eventDate: dto.event_date ? new Date(dto.event_date) : undefined,
        venue: dto.venue,
        slug,
        expiresAt,
      },
    });
  }

  async getOwned(photographerId: string, id: string) {
    const event = await this.prisma.event.findFirst({ where: { id, photographerId } });
    if (!event) throw new NotFoundException('event_not_found');
    return event;
  }

  private slugify(input: string) {
    return input.toLowerCase().trim().replace(/[^a-z0-9ก-ฮะ-์]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 90);
  }
}
