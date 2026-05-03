import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { CurrentUser, CurrentUserPayload } from '../../common/current-user';
import { JwtAuthGuard } from '../../common/jwt-auth.guard';
import { WatermarkService } from './watermark.service';

@UseGuards(JwtAuthGuard)
@Controller('watermark')
export class WatermarkController {
  constructor(private readonly watermark: WatermarkService) {}

  @Get()
  get(@CurrentUser() user: CurrentUserPayload) {
    return this.watermark.get(user.sub);
  }

  @Put()
  put(@CurrentUser() user: CurrentUserPayload, @Body() body: { enabled?: boolean; text?: string; position?: string; size?: string; opacity?: number }) {
    return this.watermark.upsert(user.sub, body);
  }
}
