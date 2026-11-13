import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  isOpaqueCookieToken,
  ME_ROUTES,
  VIEWER_SESSION_COOKIE,
  viewerSessionCookie,
} from '@shotx/shared';
import type { Request, Response } from 'express';
import { CurrentUser, UserGuard, type UserPrincipal } from '../auth/photographer.guard';
import { OriginGuard } from '../auth/public.guard';
import { type ApiConfig, secureCookies } from '../config';
import { ApiError } from '../http/api-error';
import { clearCookie, readCookies, setCookie } from '../http/cookies';
import { respond } from '../http/zod';
import { API_CONFIG } from '../tokens';
import { MeService } from './me.service';

const R = ME_ROUTES;

/** ME_ROUTES. */
@Controller()
export class MeController {
  constructor(
    @Inject(MeService) private readonly me: MeService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  private cookie() {
    return viewerSessionCookie(
      this.config.share.viewerSessionTtlSeconds,
      secureCookies(this.config),
    );
  }

  @Get(R.get.path)
  @HttpCode(R.get.status)
  @UseGuards(UserGuard)
  async get(@CurrentUser() user: UserPrincipal) {
    return respond(
      R.get.response,
      await this.me.me(user.id, user.passwordChangeRequired, undefined, user.actingAdminId),
    );
  }

  /**
   * Deprecated (ADR 0010): self-serve onboarding is gone; only an admin creates photographer
   * accounts (POST /admin/users). FORBIDDEN for everyone, whatever the body.
   */
  @Post(R.becomePhotographer.path)
  @HttpCode(R.becomePhotographer.status)
  @UseGuards(UserGuard)
  becomePhotographer(): never {
    throw new ApiError('FORBIDDEN', 'Accounts are created by an admin');
  }

  /** Sets the viewer-session cookie; the web BFF passes its Set-Cookie on to the browser. */
  @Post(R.createViewerSession.path)
  @HttpCode(R.createViewerSession.status)
  @UseGuards(UserGuard)
  async createViewerSession(
    @CurrentUser() user: UserPrincipal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    setCookie(res, this.cookie(), await this.me.createViewerSession(user.id));
  }

  /** Ends the session of the cookie (if any) and clears it. Works with an expired session. */
  @Delete(R.deleteViewerSession.path)
  @HttpCode(R.deleteViewerSession.status)
  @UseGuards(OriginGuard)
  async deleteViewerSession(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const token = readCookies(req).get(VIEWER_SESSION_COOKIE);
    if (token !== undefined && isOpaqueCookieToken(token)) await this.me.deleteViewerSession(token);
    clearCookie(res, this.cookie());
  }
}
