import { Body, Controller, Get, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { AUTH_ROUTES, type AuthPool } from '@shotx/shared';
import type { z } from 'zod';
import { respond, ZodPipe } from '../http/zod';
import { ActAsService } from '../admin/act-as.service';
import { AdminSignIn } from './admin-sign-in';
import { AuthService } from './auth.service';
import { ApiError } from '../http/api-error';
import { BffGuard, BffIpHash, BffKeyPool } from './bff.guard';
import { PhotographerSignIn } from './photographer-sign-in';

const R = AUTH_ROUTES;
type Out<T extends z.ZodType> = z.output<T>;

/**
 * AUTH_ROUTES (ADR 0008 section 4): called server-side by the web and admin BFFs only (BffGuard).
 * Request bodies (codes, passwords, tokens) are never logged.
 */
@Controller()
@UseGuards(BffGuard)
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AdminSignIn) private readonly admin: AdminSignIn,
    @Inject(PhotographerSignIn) private readonly photographer: PhotographerSignIn,
    @Inject(ActAsService) private readonly actAs: ActAsService,
  ) {}

  /** ADR 0018: web exchanges an admin's one-time act-as code for the photographer's session. */
  @Post(R.actAs.path)
  @HttpCode(R.actAs.status)
  async actAsExchange(@Body(new ZodPipe(R.actAs.body, 'body')) body: Out<typeof R.actAs.body>) {
    return respond(R.actAs.response, await this.actAs.exchange(body.code));
  }

  @Get(R.providers.path)
  @HttpCode(R.providers.status)
  providers() {
    return respond(R.providers.response, this.auth.providers());
  }

  @Post(R.oidcStart.path)
  @HttpCode(R.oidcStart.status)
  async oidcStart(
    @Param(new ZodPipe(R.oidcStart.params, 'params')) params: Out<typeof R.oidcStart.params>,
    @Body(new ZodPipe(R.oidcStart.body, 'body')) body: Out<typeof R.oidcStart.body>,
    @BffIpHash() ipHash: string,
  ) {
    return respond(
      R.oidcStart.response,
      await this.auth.oidcStart(params.provider, body.redirectUri, ipHash),
    );
  }

  @Post(R.oidcCallback.path)
  @HttpCode(R.oidcCallback.status)
  async oidcCallback(
    @Body(new ZodPipe(R.oidcCallback.body, 'body')) body: Out<typeof R.oidcCallback.body>,
    @BffIpHash() ipHash: string,
  ) {
    return respond(
      R.oidcCallback.response,
      await this.auth.oidcCallback(body.state, body.code, ipHash),
    );
  }

  @Post(R.devLogin.path)
  @HttpCode(R.devLogin.status)
  async devLogin(
    @Body(new ZodPipe(R.devLogin.body, 'body')) body: Out<typeof R.devLogin.body>,
    @BffIpHash() ipHash: string,
  ) {
    return respond(R.devLogin.response, await this.auth.devLogin(body.email, body.name, ipHash));
  }

  @Post(R.refresh.path)
  @HttpCode(R.refresh.status)
  async refresh(
    @Body(new ZodPipe(R.refresh.body, 'body')) body: Out<typeof R.refresh.body>,
    @BffKeyPool() keyPool: AuthPool,
  ) {
    // `bffKey: 'request'`: only the app of the body's pool may refresh its tokens.
    if (body.pool !== keyPool) throw new ApiError('UNAUTHENTICATED', 'Server-side callers only');
    return respond(R.refresh.response, await this.auth.refresh(body.refreshToken, body.pool));
  }

  @Post(R.logout.path)
  @HttpCode(R.logout.status)
  async logout(
    @Body(new ZodPipe(R.logout.body, 'body')) body: Out<typeof R.logout.body>,
    @BffKeyPool() keyPool: AuthPool,
  ) {
    // `bffKey: 'request'`: a token of the other app's pool is treated as unknown (204).
    await this.auth.logout(body.refreshToken, keyPool);
  }

  @Post(R.adminLogin.path)
  @HttpCode(R.adminLogin.status)
  async adminLogin(
    @Body(new ZodPipe(R.adminLogin.body, 'body')) body: Out<typeof R.adminLogin.body>,
    @BffIpHash() ipHash: string,
  ) {
    return respond(
      R.adminLogin.response,
      await this.admin.login(body.email, body.password, ipHash),
    );
  }

  @Post(R.adminChangePassword.path)
  @HttpCode(R.adminChangePassword.status)
  async adminChangePassword(
    @Body(new ZodPipe(R.adminChangePassword.body, 'body'))
    body: Out<typeof R.adminChangePassword.body>,
    @BffIpHash() ipHash: string,
  ) {
    return respond(
      R.adminChangePassword.response,
      await this.admin.changePassword(body.challengeId, body.newPassword, ipHash),
    );
  }

  @Post(R.photographerSignIn.path)
  @HttpCode(R.photographerSignIn.status)
  async photographerSignIn(
    @Body(new ZodPipe(R.photographerSignIn.body, 'body'))
    body: Out<typeof R.photographerSignIn.body>,
    @BffIpHash() ipHash: string,
  ) {
    return respond(
      R.photographerSignIn.response,
      await this.photographer.signIn(body.email, body.password, ipHash),
    );
  }

  @Post(R.adminMfa.path)
  @HttpCode(R.adminMfa.status)
  async adminMfa(
    @Body(new ZodPipe(R.adminMfa.body, 'body')) body: Out<typeof R.adminMfa.body>,
    @BffIpHash() ipHash: string,
  ) {
    return respond(
      R.adminMfa.response,
      await this.admin.verifyMfa(body.challengeId, body.code, ipHash),
    );
  }
}
