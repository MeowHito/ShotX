import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { PHOTOGRAPHER_ACCOUNT_ROUTES } from '@shotx/shared';
import type { Request } from 'express';
import type { z } from 'zod';
import { type ApiConfig, clientIpTrust } from '../config';
import { clientIp, ipHash } from '../http/client';
import { respond, ZodPipe } from '../http/zod';
import { API_CONFIG } from '../tokens';
import { CurrentPhotographer, type Photographer, PhotographerGuard } from './photographer.guard';
import { PhotographerSignIn } from './photographer-sign-in';

const R = PHOTOGRAPHER_ACCOUNT_ROUTES;
type Out<T extends z.ZodType> = z.output<T>;

/**
 * PHOTOGRAPHER_ACCOUNT_ROUTES (ADR 0010). `serverOnly`: the web BFF calls it from its own route
 * handler with the photographer's token and swaps its session cookie for the answered tokens.
 * Allowed for a restricted session (PASSWORD_CHANGE_ALLOWED_ROUTES). Bodies are never logged.
 */
@Controller()
export class PhotographerAccountController {
  constructor(
    @Inject(PhotographerSignIn) private readonly signIn: PhotographerSignIn,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Post(R.changePassword.path)
  @HttpCode(R.changePassword.status)
  @UseGuards(PhotographerGuard)
  async changePassword(
    @CurrentPhotographer() photographer: Photographer,
    @Req() req: Request,
    @Body(new ZodPipe(R.changePassword.body, 'body')) body: Out<typeof R.changePassword.body>,
  ) {
    const callerIp = ipHash(
      this.config.consent.ipHashSecret,
      clientIp(req, clientIpTrust(this.config)),
    );
    return respond(
      R.changePassword.response,
      await this.signIn.changePassword(
        photographer.id,
        body.currentPassword,
        body.newPassword,
        callerIp,
      ),
    );
  }
}
