import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { DRIVE_ROUTES, IDEMPOTENCY_KEY_HEADER } from '@shotx/shared';
import type { Request } from 'express';
import type { z } from 'zod';
import {
  CurrentPhotographer,
  type Photographer,
  PhotographerGuard,
} from '../auth/photographer.guard';
import { parseRequestPart, respond, ZodPipe } from '../http/zod';
import { StudioService } from './studio.service';

const R = DRIVE_ROUTES;
type Out<T extends z.ZodType> = z.output<T>;

/** The Wave 7 studio routes of DRIVE_ROUTES (copy, folder zip, recent, search, item info). */
@Controller()
@UseGuards(PhotographerGuard)
export class StudioController {
  constructor(@Inject(StudioService) private readonly studio: StudioService) {}

  @Post(R.copyFile.path)
  @HttpCode(R.copyFile.status)
  async copyFile(
    @CurrentPhotographer() me: Photographer,
    @Param(new ZodPipe(R.copyFile.params, 'params')) params: Out<typeof R.copyFile.params>,
    @Body(new ZodPipe(R.copyFile.body, 'body')) body: Out<typeof R.copyFile.body>,
  ) {
    return respond(R.copyFile.response, await this.studio.copyFile(me.id, params.id, body));
  }

  @Post(R.downloadFolder.path)
  @HttpCode(R.downloadFolder.status)
  async downloadFolder(
    @CurrentPhotographer() me: Photographer,
    @Req() req: Request,
    @Param(new ZodPipe(R.downloadFolder.params, 'params'))
    params: Out<typeof R.downloadFolder.params>,
    @Body(new ZodPipe(R.downloadFolder.body, 'body')) body: Out<typeof R.downloadFolder.body>,
  ) {
    const headers = parseRequestPart(R.downloadFolder.headers, 'headers', {
      [IDEMPOTENCY_KEY_HEADER]: req.headers[IDEMPOTENCY_KEY_HEADER],
    });
    return respond(
      R.downloadFolder.response,
      await this.studio.downloadFolder(
        me.id,
        params.id,
        body.size,
        headers[IDEMPOTENCY_KEY_HEADER],
      ),
    );
  }

  @Get(R.ownerZipJob.path)
  @HttpCode(R.ownerZipJob.status)
  async ownerZipJob(
    @CurrentPhotographer() me: Photographer,
    @Param(new ZodPipe(R.ownerZipJob.params, 'params')) params: Out<typeof R.ownerZipJob.params>,
  ) {
    return respond(R.ownerZipJob.response, await this.studio.ownerZipJob(me.id, params.id));
  }

  @Get(R.recent.path)
  @HttpCode(R.recent.status)
  async recent(
    @CurrentPhotographer() me: Photographer,
    @Query(new ZodPipe(R.recent.query, 'query')) query: Out<typeof R.recent.query>,
  ) {
    return respond(R.recent.response, await this.studio.recent(me.id, query));
  }

  @Get(R.search.path)
  @HttpCode(R.search.status)
  async search(
    @CurrentPhotographer() me: Photographer,
    @Query(new ZodPipe(R.search.query, 'query')) query: Out<typeof R.search.query>,
  ) {
    return respond(R.search.response, await this.studio.search(me.id, query));
  }

  @Get(R.getFile.path)
  @HttpCode(R.getFile.status)
  async getFile(
    @CurrentPhotographer() me: Photographer,
    @Param(new ZodPipe(R.getFile.params, 'params')) params: Out<typeof R.getFile.params>,
  ) {
    return respond(R.getFile.response, await this.studio.getFile(me.id, params.id));
  }

  @Get(R.folderSummary.path)
  @HttpCode(R.folderSummary.status)
  async folderSummary(
    @CurrentPhotographer() me: Photographer,
    @Param(new ZodPipe(R.folderSummary.params, 'params'))
    params: Out<typeof R.folderSummary.params>,
  ) {
    return respond(R.folderSummary.response, await this.studio.folderSummary(me.id, params.id));
  }
}
