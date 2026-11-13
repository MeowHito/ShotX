import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { IDEMPOTENCY_KEY_HEADER, PUBLIC_SHARE_ROUTES, shareUnlockCookie } from '@shotx/shared';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { CurrentPublic, type PublicContext, PublicGuard } from '../auth/public.guard';
import { type ApiConfig, secureCookies } from '../config';
import { setCookie } from '../http/cookies';
import { parseRequestPart, respond, ZodPipe } from '../http/zod';
import { API_CONFIG } from '../tokens';
import { DownloadsService } from './downloads.service';
import { FaceService } from './face.service';
import { SharePageService } from './share-page.service';

const R = PUBLIC_SHARE_ROUTES;
type Out<T extends z.ZodType> = z.output<T>;

/**
 * PUBLIC_SHARE_ROUTES. `:token` is not validated by a pipe: ShareAccess answers NOT_FOUND for
 * malformed and unknown tokens alike, so the response never tells them apart.
 */
@Controller()
@UseGuards(PublicGuard)
export class PublicShareController {
  constructor(
    @Inject(SharePageService) private readonly page: SharePageService,
    @Inject(FaceService) private readonly face: FaceService,
    @Inject(DownloadsService) private readonly downloads: DownloadsService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get(R.meta.path)
  @HttpCode(R.meta.status)
  async meta(@CurrentPublic() ctx: PublicContext, @Param('token') token: string) {
    return respond(R.meta.response, await this.page.meta(token, ctx));
  }

  @Get(R.items.path)
  @HttpCode(R.items.status)
  async items(
    @CurrentPublic() ctx: PublicContext,
    @Param('token') token: string,
    @Query(new ZodPipe(R.items.query, 'query')) query: Out<typeof R.items.query>,
  ) {
    return respond(R.items.response, await this.page.items(token, ctx, query));
  }

  @Get(R.changes.path)
  @HttpCode(R.changes.status)
  async changes(@CurrentPublic() ctx: PublicContext, @Param('token') token: string) {
    return respond(R.changes.response, await this.page.changes(token, ctx));
  }

  @Post(R.unlock.path)
  @HttpCode(R.unlock.status)
  async unlock(
    @CurrentPublic() ctx: PublicContext,
    @Param('token') token: string,
    @Body(new ZodPipe(R.unlock.body, 'body')) body: Out<typeof R.unlock.body>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const unlocked = await this.page.unlock(token, ctx, body.password);
    if (unlocked === null) return;
    // The share's token, whatever ref the request used (ADR 0011).
    const spec = shareUnlockCookie(
      unlocked.shareToken,
      this.config.share.unlockTtlSeconds,
      secureCookies(this.config),
    );
    setCookie(res, spec, unlocked.cookie);
  }

  @Post(R.giveConsent.path)
  @HttpCode(R.giveConsent.status)
  async giveConsent(
    @CurrentPublic() ctx: PublicContext,
    @Param('token') token: string,
    @Body(new ZodPipe(R.giveConsent.body, 'body')) body: Out<typeof R.giveConsent.body>,
  ) {
    return respond(R.giveConsent.response, await this.page.giveConsent(token, ctx, body));
  }

  @Delete(R.withdrawConsent.path)
  @HttpCode(R.withdrawConsent.status)
  async withdrawConsent(
    @CurrentPublic() ctx: PublicContext,
    @Param('token') token: string,
  ): Promise<void> {
    await this.page.withdrawConsent(token, ctx);
  }

  /** Multipart selfies, read in memory by FaceService after the gates (never logged). */
  @Post(R.faceSearch.path)
  @HttpCode(R.faceSearch.status)
  async faceSearch(
    @CurrentPublic() ctx: PublicContext,
    @Param('token') token: string,
    @Req() req: Request,
  ) {
    return respond(R.faceSearch.response, await this.face.faceSearch(token, ctx, req));
  }

  @Post(R.feedback.path)
  @HttpCode(R.feedback.status)
  async feedback(
    @CurrentPublic() ctx: PublicContext,
    @Param('token') token: string,
    @Body(new ZodPipe(R.feedback.body, 'body')) body: Out<typeof R.feedback.body>,
  ): Promise<void> {
    await this.face.feedback(token, ctx, body.fileId);
  }

  @Get(R.faceDeletionInfo.path)
  @HttpCode(R.faceDeletionInfo.status)
  async faceDeletionInfo(@CurrentPublic() ctx: PublicContext, @Param('token') token: string) {
    return respond(R.faceDeletionInfo.response, await this.page.faceDeletionInfo(token, ctx));
  }

  @Post(R.faceDeletion.path)
  @HttpCode(R.faceDeletion.status)
  async faceDeletion(
    @CurrentPublic() ctx: PublicContext,
    @Param('token') token: string,
    @Req() req: Request,
  ) {
    return respond(R.faceDeletion.response, await this.face.faceDeletion(token, ctx, req));
  }

  @Post(R.downloads.path)
  @HttpCode(R.downloads.status)
  async createDownload(
    @CurrentPublic() ctx: PublicContext,
    @Param('token') token: string,
    @Req() req: Request,
    @Body(new ZodPipe(R.downloads.body, 'body')) body: Out<typeof R.downloads.body>,
  ) {
    const headers = parseRequestPart(R.downloads.headers, 'headers', {
      [IDEMPOTENCY_KEY_HEADER]: req.headers[IDEMPOTENCY_KEY_HEADER],
    });
    return respond(
      R.downloads.response,
      await this.downloads.create(token, ctx, body.fileIds, headers[IDEMPOTENCY_KEY_HEADER]),
    );
  }

  @Get(R.zipJob.path)
  @HttpCode(R.zipJob.status)
  async zipJob(
    @CurrentPublic() ctx: PublicContext,
    @Param(new ZodPipe(R.zipJob.params, 'params')) params: Out<typeof R.zipJob.params>,
  ) {
    return respond(R.zipJob.response, await this.downloads.job(params.token, params.id, ctx));
  }
}
