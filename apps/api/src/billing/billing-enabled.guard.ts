import { type CanActivate, Inject, Injectable } from '@nestjs/common';
import { type ApiConfig, billingOnline } from '../config';
import { notFound } from '../http/api-error';
import { API_CONFIG } from '../tokens';

/**
 * Runs before every other guard of BILLING_ROUTES: with BILLING_MODE=offline (ADR 0010, the
 * default) each of them answers NOT_FOUND, whoever calls (no gateway is built either).
 */
@Injectable()
export class BillingEnabledGuard implements CanActivate {
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  canActivate(): boolean {
    if (!billingOnline(this.config)) throw notFound('Route');
    return true;
  }
}
