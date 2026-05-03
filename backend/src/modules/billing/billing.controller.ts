import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { CurrentUser, CurrentUserPayload } from '../../common/current-user';
import { JwtAuthGuard } from '../../common/jwt-auth.guard';
import { BillingService } from './billing.service';

@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('plans')
  plans() {
    return this.billing.listPlans();
  }

  @Get('subscription')
  @UseGuards(JwtAuthGuard)
  current(@CurrentUser() user: CurrentUserPayload) {
    return this.billing.currentSubscription(user.sub);
  }

  @Post('checkout/quote')
  @UseGuards(JwtAuthGuard)
  quote(@Body() body: { plan: string }) {
    return this.billing.checkoutQuote(body.plan);
  }

  @Post('checkout')
  @UseGuards(JwtAuthGuard)
  checkout(@CurrentUser() user: CurrentUserPayload, @Body() body: { plan: string }) {
    return this.billing.checkout(user.sub, body.plan);
  }
}
