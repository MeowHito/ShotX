import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AdminRoleGuard } from '../../common/admin-role.guard';
import { JwtAuthGuard } from '../../common/jwt-auth.guard';
import { AdminService } from './admin.service';

@UseGuards(JwtAuthGuard, AdminRoleGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('stats')
  stats() {
    return this.admin.stats();
  }

  @Get('revenue')
  revenue() {
    return this.admin.revenue();
  }

  @Get('photographers')
  photographers() {
    return this.admin.photographers();
  }

  @Get('health')
  health() {
    return this.admin.health();
  }

  @Post('subscriptions')
  createSubscription(
    @Body() body: { photographer_id: string; plan: 'basic' | 'standard' | 'pro'; amount_thb: number; period_days?: number },
  ) {
    return this.admin.createSubscription(body);
  }
}
