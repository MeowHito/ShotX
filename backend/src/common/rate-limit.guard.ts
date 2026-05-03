import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export type RateLimitOptions = {
  ttlMs: number;
  limit: number;
  keyPrefix?: string;
};

export const RATE_LIMIT_KEY = 'rate_limit_options';
export const RateLimit = (options: RateLimitOptions) => SetMetadata(RATE_LIMIT_KEY, options);

type Bucket = {
  count: number;
  resetAt: number;
};

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext) {
    const options = this.reflector.getAllAndOverride<RateLimitOptions>(RATE_LIMIT_KEY, [context.getHandler(), context.getClass()]);
    if (!options) return true;

    const request = context.switchToHttp().getRequest();
    const now = Date.now();
    const ip = this.getIp(request);
    const routeKey = `${request.method}:${request.route?.path ?? request.url}`;
    const key = `${options.keyPrefix ?? routeKey}:${ip}`;
    const bucket = this.buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + options.ttlMs });
      this.cleanup(now);
      return true;
    }

    if (bucket.count >= options.limit) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      throw new HttpException({ message: 'rate_limit_exceeded', retry_after_seconds: retryAfter }, HttpStatus.TOO_MANY_REQUESTS);
    }

    bucket.count += 1;
    return true;
  }

  private getIp(request: { ip?: string; headers?: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } }) {
    const forwarded = request.headers?.['x-forwarded-for'];
    if (typeof forwarded === 'string') return forwarded.split(',')[0]?.trim() || 'unknown';
    if (Array.isArray(forwarded)) return forwarded[0]?.split(',')[0]?.trim() || 'unknown';
    return request.ip ?? request.socket?.remoteAddress ?? 'unknown';
  }

  private cleanup(now: number) {
    if (this.buckets.size < 10000) return;
    for (const [key, bucket] of this.buckets.entries()) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}
