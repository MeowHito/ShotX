import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { EmailService } from '../email/email.service';
import { PrismaService } from '../prisma/prisma.service';
import { GoogleLoginDto, LoginDto, RegisterDto } from './dto';

type GoogleTokenInfo = {
  sub: string;
  email: string;
  email_verified?: string | boolean;
  name?: string;
  picture?: string;
  aud: string;
  exp: string;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.prisma.photographer.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictException('email_already_registered');

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const photographer = await this.prisma.photographer.create({
      data: { name: dto.name, email: dto.email, passwordHash, authProvider: 'password' },
      select: { id: true, name: true, email: true, plan: true, role: true, createdAt: true },
    });

    void this.email.sendWelcome(photographer.email, photographer.name).catch(() => undefined);

    return { token: await this.sign(photographer.id, photographer.role), photographer };
  }

  async login(dto: LoginDto) {
    const photographer = await this.prisma.photographer.findUnique({ where: { email: dto.email } });
    if (!photographer || !photographer.passwordHash) throw new UnauthorizedException('invalid_credentials');

    const ok = await bcrypt.compare(dto.password, photographer.passwordHash);
    if (!ok) throw new UnauthorizedException('invalid_credentials');

    return {
      token: await this.sign(photographer.id, photographer.role),
      photographer: this.publicProfile(photographer),
    };
  }

  async googleLogin(dto: GoogleLoginDto) {
    const payload = dto.access_token
      ? await this.fetchGoogleUserInfo(dto.access_token)
      : await this.verifyGoogleIdToken(dto.id_token ?? '');
    const email = payload.email.toLowerCase();

    let photographer = await this.prisma.photographer.findFirst({
      where: { OR: [{ googleId: payload.sub }, { email }] },
    });

    if (!photographer) {
      photographer = await this.prisma.photographer.create({
        data: {
          email,
          name: payload.name || email.split('@')[0],
          googleId: payload.sub,
          authProvider: 'google',
          avatarUrl: payload.picture,
        },
      });
      void this.email.sendWelcome(photographer.email, photographer.name).catch(() => undefined);
    } else if (!photographer.googleId) {
      photographer = await this.prisma.photographer.update({
        where: { id: photographer.id },
        data: { googleId: payload.sub, avatarUrl: photographer.avatarUrl ?? payload.picture },
      });
    }

    return {
      token: await this.sign(photographer.id, photographer.role),
      photographer: this.publicProfile(photographer),
    };
  }

  private async fetchGoogleUserInfo(accessToken: string): Promise<GoogleTokenInfo> {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new UnauthorizedException('invalid_google_access_token');
    const info = (await res.json()) as { sub?: string; email?: string; email_verified?: boolean; name?: string; picture?: string };
    if (!info.sub || !info.email) throw new UnauthorizedException('google_userinfo_missing_fields');
    if (info.email_verified !== true) throw new UnauthorizedException('google_email_not_verified');
    return {
      sub: info.sub,
      email: info.email,
      email_verified: true,
      name: info.name,
      picture: info.picture,
      aud: this.config.get<string>('GOOGLE_CLIENT_ID') ?? '',
      exp: String(Math.floor(Date.now() / 1000) + 3600),
    };
  }

  private async verifyGoogleIdToken(idToken: string): Promise<GoogleTokenInfo> {
    if (!idToken) throw new BadRequestException('id_token_or_access_token_required');
    const expectedAud = this.config.get<string>('GOOGLE_CLIENT_ID');
    if (!expectedAud) throw new BadRequestException('google_client_id_not_configured');

    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!res.ok) throw new UnauthorizedException('invalid_google_token');
    const info = (await res.json()) as GoogleTokenInfo;

    if (info.aud !== expectedAud) throw new UnauthorizedException('google_audience_mismatch');
    if (Number(info.exp) * 1000 < Date.now()) throw new UnauthorizedException('google_token_expired');
    if (!info.email) throw new UnauthorizedException('google_email_missing');
    if (info.email_verified !== true && info.email_verified !== 'true') {
      throw new UnauthorizedException('google_email_not_verified');
    }
    return info;
  }

  private publicProfile(p: { id: string; name: string; email: string; plan: string; status: string; role: string; avatarUrl: string | null }) {
    return {
      id: p.id,
      name: p.name,
      email: p.email,
      plan: p.plan,
      status: p.status,
      role: p.role,
      avatar_url: p.avatarUrl,
    };
  }

  private sign(sub: string, role: string) {
    return this.jwt.signAsync({ sub, role });
  }
}
