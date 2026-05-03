import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RateLimitGuard } from '../../common/rate-limit.guard';
import { EmailModule } from '../email/email.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  imports: [
    EmailModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({ secret: config.getOrThrow<string>('JWT_SECRET'), signOptions: { expiresIn: config.get<string>('JWT_EXPIRES_IN') ?? '1d' } }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, RateLimitGuard],
  exports: [JwtModule, AuthService],
})
export class AuthModule {}
