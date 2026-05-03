import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WatermarkController } from './watermark.controller';
import { WatermarkService } from './watermark.service';

@Module({
  imports: [AuthModule],
  controllers: [WatermarkController],
  providers: [WatermarkService],
})
export class WatermarkModule {}
