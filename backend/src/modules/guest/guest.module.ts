import { Module } from '@nestjs/common';
import { RateLimitGuard } from '../../common/rate-limit.guard';
import { StorageModule } from '../storage/storage.module';
import { GuestController } from './guest.controller';
import { GuestService } from './guest.service';
import { SelfieCleanupService } from './selfie-cleanup.service';

@Module({
  imports: [StorageModule],
  controllers: [GuestController],
  providers: [GuestService, RateLimitGuard, SelfieCleanupService],
})
export class GuestModule {}
