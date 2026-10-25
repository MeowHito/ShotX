import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SHARE_ROUTES } from '@shotx/shared';
import type { z } from 'zod';
import {
  CurrentPhotographer,
  type Photographer,
  PhotographerGuard,
} from '../auth/photographer.guard';
import { respond, ZodPipe } from '../http/zod';
import { SharesService } from './shares.service';

const R = SHARE_ROUTES;
type Out<T extends z.ZodType> = z.output<T>;

/** SHARE_ROUTES (photographer). Paths, statuses and schemas come from the shared route table. */
@Controller()
@UseGuards(PhotographerGuard)
export class SharesController {
  constructor(@Inject(SharesService) private readonly shares: SharesService) {}

  @Post(R.create.path)
  @HttpCode(R.create.status)
  async create(
    @CurrentPhotographer() me: Photographer,
    @Body(new ZodPipe(R.create.body, 'body')) body: Out<typeof R.create.body>,
  ) {
    return respond(R.create.response, await this.shares.create(me.id, body));
  }

  @Get(R.list.path)
  @HttpCode(R.list.status)
  async list(
    @CurrentPhotographer() me: Photographer,
    @Query(new ZodPipe(R.list.query, 'query')) query: Out<typeof R.list.query>,
  ) {
    return respond(R.list.response, await this.shares.list(me.id, query));
  }

  @Get(R.get.path)
  @HttpCode(R.get.status)
  async get(
    @CurrentPhotographer() me: Photographer,
    @Param(new ZodPipe(R.get.params, 'params')) params: Out<typeof R.get.params>,
  ) {
    return respond(R.get.response, await this.shares.get(me.id, params.id));
  }

  @Patch(R.update.path)
  @HttpCode(R.update.status)
  async update(
    @CurrentPhotographer() me: Photographer,
    @Param(new ZodPipe(R.update.params, 'params')) params: Out<typeof R.update.params>,
    @Body(new ZodPipe(R.update.body, 'body')) body: Out<typeof R.update.body>,
  ) {
    return respond(R.update.response, await this.shares.update(me.id, params.id, body));
  }

  @Delete(R.revoke.path)
  @HttpCode(R.revoke.status)
  async revoke(
    @CurrentPhotographer() me: Photographer,
    @Param(new ZodPipe(R.revoke.params, 'params')) params: Out<typeof R.revoke.params>,
  ): Promise<void> {
    await this.shares.revoke(me.id, params.id);
  }

  @Get(R.stats.path)
  @HttpCode(R.stats.status)
  async stats(
    @CurrentPhotographer() me: Photographer,
    @Param(new ZodPipe(R.stats.params, 'params')) params: Out<typeof R.stats.params>,
    @Query(new ZodPipe(R.stats.query, 'query')) query: Out<typeof R.stats.query>,
  ) {
    return respond(R.stats.response, await this.shares.stats(me.id, params.id, query));
  }
}
