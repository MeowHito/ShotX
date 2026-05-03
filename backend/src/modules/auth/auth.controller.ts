import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { CurrentUser, CurrentUserPayload } from '../../common/current-user';
import { JwtAuthGuard } from '../../common/jwt-auth.guard';
import { RateLimit, RateLimitGuard } from '../../common/rate-limit.guard';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { GoogleLoginDto, LoginDto, RegisterDto } from './dto';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('register')
  @UseGuards(RateLimitGuard)
  @RateLimit({ ttlMs: 60_000, limit: 5, keyPrefix: 'auth:register' })
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Post('login')
  @UseGuards(RateLimitGuard)
  @RateLimit({ ttlMs: 60_000, limit: 10, keyPrefix: 'auth:login' })
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Post('google')
  @UseGuards(RateLimitGuard)
  @RateLimit({ ttlMs: 60_000, limit: 10, keyPrefix: 'auth:google' })
  google(@Body() dto: GoogleLoginDto) {
    return this.auth.googleLogin(dto);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() user: CurrentUserPayload) {
    const p = await this.prisma.photographer.findUnique({
      where: { id: user.sub },
      select: { id: true, name: true, email: true, plan: true, status: true, role: true, avatarUrl: true, createdAt: true },
    });
    return p;
  }
}
