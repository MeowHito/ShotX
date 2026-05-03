import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { BillingService } from '../modules/billing/billing.service';

@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(private readonly billing: BillingService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    const user = request.user as { sub?: string } | undefined;
    if (!user?.sub) throw new ForbiddenException('not_authenticated');

    const sub = await this.billing.currentSubscription(user.sub);
    if (!sub) throw new ForbiddenException('subscription_required');
    request.subscription = sub;
    return true;
  }
}
