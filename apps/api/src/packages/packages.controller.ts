import {
  type CanActivate,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { IDEMPOTENCY_KEY_HEADER, ORDER_TOKEN_HEADER, PACKAGE_ROUTES } from '@shotx/shared';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { BffGuard, BffIpHash } from '../auth/bff.guard';
import {
  CurrentPhotographer,
  OptionalPhotographer,
  OptionalPhotographerGuard,
  type Photographer,
  PhotographerGuard,
} from '../auth/photographer.guard';
import { type ApiConfig, clientIpTrust } from '../config';
import { clientIp } from '../http/client';
import { ApiError, notFound } from '../http/api-error';
import { rawBodyOf } from '../http/json-body';
import { parseRequestPart, respond, ZodPipe } from '../http/zod';
import { API_CONFIG } from '../tokens';
import { PackagesService } from './packages.service';

const R = PACKAGE_ROUTES;
type Out<T extends z.ZodType> = z.output<T>;

/**
 * PACKAGE_SALES=off (ADR 0026, the default): Free sign-up and new orders answer NOT_FOUND, before
 * any other guard. GET /packages, order polling, gateway callbacks and GET /me/package keep working.
 */
@Injectable()
export class PackageSalesGuard implements CanActivate {
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  canActivate(): boolean {
    if (!this.config.packages.salesEnabled) throw notFound('Route');
    return true;
  }
}

/** Lowercase header map for gateway adapters (first value of repeated headers). */
function lowercaseHeaders(req: Request): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    out[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}

/** X-Order-Token; a missing or malformed one is ORDER_NOT_FOUND like a wrong one. */
function orderToken(req: Request): string {
  const parsed = R.getOrder.headers.safeParse({
    [ORDER_TOKEN_HEADER]: req.headers[ORDER_TOKEN_HEADER],
  });
  if (!parsed.success) throw new ApiError('ORDER_NOT_FOUND', 'Order not found');
  return parsed.data[ORDER_TOKEN_HEADER];
}

/**
 * PACKAGE_ROUTES (ADR 0026). The `bff` routes are called by web's server code only (BffGuard);
 * their bodies (names, emails, passwords, tokens) are never logged. The webhook has its own auth:
 * the adapter checks the signature over the raw body.
 */
@Controller()
export class PackagesController {
  constructor(
    @Inject(PackagesService) private readonly packages: PackagesService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get(R.list.path)
  @HttpCode(R.list.status)
  async list(@Res({ passthrough: true }) res: Response) {
    res.setHeader(
      'Cache-Control',
      `public, max-age=${this.config.packages.listCacheMaxAgeSeconds}`,
    );
    return respond(R.list.response, await this.packages.list());
  }

  @Post(R.signupFree.path)
  @HttpCode(R.signupFree.status)
  @UseGuards(PackageSalesGuard, BffGuard)
  async signupFree(
    @Body(new ZodPipe(R.signupFree.body, 'body')) body: Out<typeof R.signupFree.body>,
    @BffIpHash() ipHash: string,
    @Req() req: Request,
  ): Promise<void> {
    // The end user's address (the BFF passes it), only for Turnstile's `remoteip`.
    const remoteIp = clientIp(req, clientIpTrust(this.config));
    await this.packages.signupFree(body, { ipHash, remoteIp });
  }

  @Post(R.signupFreeConfirm.path)
  @HttpCode(R.signupFreeConfirm.status)
  @UseGuards(PackageSalesGuard, BffGuard)
  async signupFreeConfirm(
    @Body(new ZodPipe(R.signupFreeConfirm.body, 'body'))
    body: Out<typeof R.signupFreeConfirm.body>,
    @BffIpHash() ipHash: string,
  ) {
    return respond(
      R.signupFreeConfirm.response,
      await this.packages.confirmSignup(body.token, body.password, ipHash),
    );
  }

  /** ADR 0030: what a coupon makes a package cost (holds nothing). */
  @Post(R.checkCoupon.path)
  @HttpCode(R.checkCoupon.status)
  @UseGuards(PackageSalesGuard, BffGuard)
  async checkCoupon(
    @Body(new ZodPipe(R.checkCoupon.body, 'body')) body: Out<typeof R.checkCoupon.body>,
    @BffIpHash() ipHash: string,
  ) {
    return respond(R.checkCoupon.response, await this.packages.checkCoupon(body, ipHash));
  }

  @Post(R.createOrder.path)
  @HttpCode(R.createOrder.status)
  @UseGuards(PackageSalesGuard, BffGuard, OptionalPhotographerGuard)
  async createOrder(
    @OptionalPhotographer() photographer: Photographer | null,
    @Req() req: Request,
    @Body(new ZodPipe(R.createOrder.body, 'body')) body: Out<typeof R.createOrder.body>,
    @BffIpHash() ipHash: string,
  ) {
    const headers = parseRequestPart(R.createOrder.headers, 'headers', {
      [IDEMPOTENCY_KEY_HEADER]: req.headers[IDEMPOTENCY_KEY_HEADER],
    });
    return respond(
      R.createOrder.response,
      await this.packages.createOrder(
        photographer?.id ?? null,
        body,
        headers[IDEMPOTENCY_KEY_HEADER],
        ipHash,
      ),
    );
  }

  @Get(R.getOrder.path)
  @HttpCode(R.getOrder.status)
  @UseGuards(BffGuard)
  async getOrder(
    @Param(new ZodPipe(R.getOrder.params, 'params')) params: Out<typeof R.getOrder.params>,
    @Req() req: Request,
  ) {
    return respond(R.getOrder.response, await this.packages.getOrder(params.id, orderToken(req)));
  }

  /** ADR 0029: one payment attempt from the pay page (a PromptPay QR or a card form). */
  @Post(R.pay.path)
  @HttpCode(R.pay.status)
  @UseGuards(BffGuard)
  async pay(
    @Param(new ZodPipe(R.pay.params, 'params')) params: Out<typeof R.pay.params>,
    @Req() req: Request,
    @Body(new ZodPipe(R.pay.body, 'body')) body: Out<typeof R.pay.body>,
  ) {
    return respond(
      R.pay.response,
      await this.packages.startPayment(params.id, orderToken(req), body.method),
    );
  }

  @Post(R.fakeResult.path)
  @HttpCode(R.fakeResult.status)
  @UseGuards(BffGuard)
  async fakeResult(
    @Param(new ZodPipe(R.fakeResult.params, 'params')) params: Out<typeof R.fakeResult.params>,
    @Req() req: Request,
    @Body(new ZodPipe(R.fakeResult.body, 'body')) body: Out<typeof R.fakeResult.body>,
  ) {
    // NOT_FOUND unless PACKAGE_GATEWAY=fake comes before the token check.
    this.packages.assertFakeGateway();
    return respond(
      R.fakeResult.response,
      await this.packages.fakeResult(params.id, orderToken(req), body.result),
    );
  }

  /** Raw body (json-body middleware), verified by the gateway adapter before anything else. */
  @Post(R.webhook.path)
  @HttpCode(R.webhook.status)
  async webhook(
    @Param(new ZodPipe(R.webhook.params, 'params')) params: Out<typeof R.webhook.params>,
    @Req() req: Request,
  ) {
    await this.packages.webhook(params.gateway, rawBodyOf(req.body), lowercaseHeaders(req));
    return respond(R.webhook.response, { received: true });
  }

  /** JSON `null` for an unlimited account (Nest would send an empty body for a null return). */
  @Get(R.myPackage.path)
  @HttpCode(R.myPackage.status)
  @UseGuards(PhotographerGuard)
  async myPackage(@CurrentPhotographer() photographer: Photographer, @Res() res: Response) {
    const value = respond(R.myPackage.response, await this.packages.myPackage(photographer.id));
    res.status(R.myPackage.status).json(value);
  }
}
