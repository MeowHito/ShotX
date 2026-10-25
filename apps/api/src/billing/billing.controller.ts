import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { BILLING_ROUTES, IDEMPOTENCY_KEY_HEADER } from '@shotx/shared';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import {
  CurrentPhotographer,
  type Photographer,
  PhotographerGuard,
} from '../auth/photographer.guard';
import { rawBodyOf } from '../http/json-body';
import { parseRequestPart, respond, ZodPipe } from '../http/zod';
import { BillingService } from './billing.service';
import { WebhookService } from './webhook.service';

const R = BILLING_ROUTES;
type Out<T extends z.ZodType> = z.output<T>;

/** Lowercase header map for gateway adapters (first value of repeated headers). */
function lowercaseHeaders(req: Request): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    out[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}

/** BILLING_ROUTES. `GET /plans` is public; the webhook has its own auth (the signature). */
@Controller()
export class BillingController {
  constructor(
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(WebhookService) private readonly webhooks: WebhookService,
  ) {}

  @Get(R.plans.path)
  @HttpCode(R.plans.status)
  async plans(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'public, max-age=60');
    return respond(R.plans.response, await this.billing.plans());
  }

  @Post(R.checkout.path)
  @HttpCode(R.checkout.status)
  @UseGuards(PhotographerGuard)
  async checkout(
    @CurrentPhotographer() photographer: Photographer,
    @Req() req: Request,
    @Body(new ZodPipe(R.checkout.body, 'body')) body: Out<typeof R.checkout.body>,
  ) {
    const headers = parseRequestPart(R.checkout.headers, 'headers', {
      [IDEMPOTENCY_KEY_HEADER]: req.headers[IDEMPOTENCY_KEY_HEADER],
    });
    return respond(
      R.checkout.response,
      await this.billing.checkout(photographer.id, headers[IDEMPOTENCY_KEY_HEADER], body),
    );
  }

  @Get(R.payment.path)
  @HttpCode(R.payment.status)
  @UseGuards(PhotographerGuard)
  async payment(
    @CurrentPhotographer() photographer: Photographer,
    @Param(new ZodPipe(R.payment.params, 'params')) params: Out<typeof R.payment.params>,
  ) {
    return respond(R.payment.response, await this.billing.payment(photographer.id, params.id));
  }

  @Get(R.subscription.path)
  @HttpCode(R.subscription.status)
  @UseGuards(PhotographerGuard)
  async subscription(@CurrentPhotographer() photographer: Photographer) {
    return respond(R.subscription.response, await this.billing.subscription(photographer.id));
  }

  @Post(R.cancelSubscription.path)
  @HttpCode(R.cancelSubscription.status)
  @UseGuards(PhotographerGuard)
  async cancel(@CurrentPhotographer() photographer: Photographer) {
    return respond(R.cancelSubscription.response, await this.billing.cancel(photographer.id));
  }

  /** Raw body (json-body middleware), verified by the gateway adapter before anything else. */
  @Post(R.webhook.path)
  @HttpCode(R.webhook.status)
  async webhook(
    @Param(new ZodPipe(R.webhook.params, 'params')) params: Out<typeof R.webhook.params>,
    @Req() req: Request,
  ) {
    await this.webhooks.receive(params.gateway, rawBodyOf(req.body), lowercaseHeaders(req));
    return respond(R.webhook.response, { received: true });
  }
}
