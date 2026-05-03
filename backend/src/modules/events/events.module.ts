import { Module } from '@nestjs/common';
import { SubscriptionGuard } from '../../common/subscription.guard';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';

@Module({
  imports: [AuthModule, BillingModule],
  controllers: [EventsController],
  providers: [EventsService, SubscriptionGuard],
  exports: [EventsService],
})
export class EventsModule {}
