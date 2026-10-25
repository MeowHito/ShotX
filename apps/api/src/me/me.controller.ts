import {
  Body,
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
import type { z } from 'zod';
import { CurrentUser, UserGuard } from '../auth/photographer.guard';
import { OriginGuard } from '../auth/public.guard';
import type { AppUser } from '../auth/users';
import { type ApiConfig, secureCookies } from '../config';
import { clearCookie, readCookies, setCookie } from '../http/cookies';
import { respond, ZodPipe } from '../http/zod';
import { API_CONFIG } from '../tokens';
import { MeService } from './me.service';

const R = ME_ROUTES;
type Out<T extends z.ZodType> = z.output<T>;

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
  async get(@CurrentUser() user: AppUser) {
    return respond(R.get.response, await this.me.me(user.id));
  }

  @Post(R.becomePhotographer.path)
  @HttpCode(R.becomePhotographer.status)
  @UseGuards(UserGuard)
  async becomePhotographer(
    @CurrentUser() user: AppUser,
    @Body(new ZodPipe(R.becomePhotographer.body, 'body'))
    body: Out<typeof R.becomePhotographer.body>,
  ) {
    return respond(R.becomePhotographer.response, await this.me.becomePhotographer(user.id, body));
  }

  /** Sets the viewer-session cookie; the web BFF passes its Set-Cookie on to the browser. */
  @Post(R.createViewerSession.path)
  @HttpCode(R.createViewerSession.status)
  @UseGuards(UserGuard)
  async createViewerSession(
    @CurrentUser() user: AppUser,
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
