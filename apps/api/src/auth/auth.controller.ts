import { Body, Controller, Get, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { AUTH_ROUTES } from '@shotx/shared';
import type { z } from 'zod';
import { respond, ZodPipe } from '../http/zod';
import { AdminSignIn } from './admin-sign-in';
import { AuthService } from './auth.service';
import { BffGuard, BffIpHash } from './bff.guard';

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
  ) {}

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
  async refresh(@Body(new ZodPipe(R.refresh.body, 'body')) body: Out<typeof R.refresh.body>) {
    return respond(R.refresh.response, await this.auth.refresh(body.refreshToken, body.pool));
  }

  @Post(R.logout.path)
  @HttpCode(R.logout.status)
  async logout(@Body(new ZodPipe(R.logout.body, 'body')) body: Out<typeof R.logout.body>) {
    await this.auth.logout(body.refreshToken);
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
