import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AdminSecretGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext) {
    const secret = this.config.get<string>('ADMIN_SECRET');
    if (!secret) throw new ForbiddenException('admin_secret_not_configured');

    const request = context.switchToHttp().getRequest();
    const header = request.headers['x-admin-secret'];
    const provided = Array.isArray(header) ? header[0] : header;
    if (provided !== secret) throw new UnauthorizedException('invalid_admin_secret');

    return true;
  }
}
