import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AdminModule } from './modules/admin/admin.module';
import { AuthModule } from './modules/auth/auth.module';
import { BillingModule } from './modules/billing/billing.module';
import { EventsModule } from './modules/events/events.module';
import { GuestModule } from './modules/guest/guest.module';
import { HealthModule } from './modules/health/health.module';
import { PhotosModule } from './modules/photos/photos.module';
import { PrismaModule } from './modules/prisma/prisma.module';
import { QueueModule } from './modules/queue/queue.module';
import { StorageModule } from './modules/storage/storage.module';
import { WatermarkModule } from './modules/watermark/watermark.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../.env'] }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({ connection: { url: config.get<string>('REDIS_URL') } }),
    }),
    PrismaModule,
    StorageModule,
    QueueModule,
    HealthModule,
    AuthModule,
    BillingModule,
    EventsModule,
    PhotosModule,
    GuestModule,
    WatermarkModule,
    AdminModule,
  ],
})
export class AppModule {}
