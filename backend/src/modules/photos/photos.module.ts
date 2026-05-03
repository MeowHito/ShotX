import { Module } from '@nestjs/common';
import { SubscriptionGuard } from '../../common/subscription.guard';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { PhotosController } from './photos.controller';
import { PhotosService } from './photos.service';

@Module({
  imports: [AuthModule, StorageModule, QueueModule, BillingModule],
  controllers: [PhotosController],
  providers: [PhotosService, SubscriptionGuard],
})
export class PhotosModule {}
