import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

@Injectable()
export class SelfieCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SelfieCleanupService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    if (this.config.get<string>('NODE_ENV') === 'test') return;
    const intervalMs = Number(this.config.get<string>('SELFIE_CLEANUP_INTERVAL_MS') ?? 60 * 60 * 1000);
    this.timer = setInterval(() => this.run().catch((err) => this.logger.error(err)), intervalMs);
    void this.run();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async run() {
    const ttlHours = Number(this.config.get<string>('SELFIE_TTL_HOURS') ?? 24);
    const cutoff = new Date(Date.now() - ttlHours * 60 * 60 * 1000);
    const expired = await this.prisma.guestSearch.findMany({
      where: { selfieDeleted: false, selfieUrl: { not: null }, createdAt: { lt: cutoff } },
      take: 200,
    });
    if (!expired.length) return;

    for (const search of expired) {
      try {
        if (search.selfieUrl) {
          const key = this.storage.keyFromUrl(search.selfieUrl);
          if (key) await this.storage.deleteObject(key);
        }
        await this.prisma.guestSearch.update({
          where: { id: search.id },
          data: { selfieDeleted: true, selfieUrl: null },
        });
      } catch (err) {
        this.logger.warn(`failed to cleanup selfie ${search.id}: ${(err as Error).message}`);
      }
    }
    this.logger.log(`cleaned ${expired.length} selfie(s)`);
  }
}
