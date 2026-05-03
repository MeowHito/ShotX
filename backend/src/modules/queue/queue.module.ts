import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { AiPhotoProcessor } from './ai-photo.processor';
import { AiQueueService } from './ai-queue.service';

@Module({
  imports: [BullModule.registerQueue({ name: 'ai-photos' }), PrismaModule, StorageModule],
  providers: [AiQueueService, AiPhotoProcessor],
  exports: [AiQueueService],
})
export class QueueModule {}
