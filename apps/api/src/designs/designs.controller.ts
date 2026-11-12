import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { DESIGN_ROUTES } from '@shotx/shared';
import type { z } from 'zod';
import {
  CurrentPhotographer,
  type Photographer,
  PhotographerGuard,
} from '../auth/photographer.guard';
import { respond, ZodPipe } from '../http/zod';
import { DesignsService } from './designs.service';

const R = DESIGN_ROUTES;
type Out<T extends z.ZodType> = z.output<T>;

/**
 * DESIGN_ROUTES (ADR 0013), photographer only. The image routes are declared first: Nest
 * registers handlers in declaration order, and `GET /designs/assets` must match before
 * `GET /designs/:id` would take `assets` for an id.
 */
@Controller()
@UseGuards(PhotographerGuard)
export class DesignsController {
  constructor(@Inject(DesignsService) private readonly designs: DesignsService) {}

  // --- design images ---------------------------------------------------------------------------

  @Get(R.listAssets.path)
  @HttpCode(R.listAssets.status)
  async listAssets(
    @CurrentPhotographer() me: Photographer,
    @Query(new ZodPipe(R.listAssets.query, 'query')) query: Out<typeof R.listAssets.query>,
  ) {
    return respond(R.listAssets.response, await this.designs.listAssets(me.id, query));
  }

  @Post(R.createAsset.path)
  @HttpCode(R.createAsset.status)
  async createAsset(
    @CurrentPhotographer() me: Photographer,
    @Body(new ZodPipe(R.createAsset.body, 'body')) body: Out<typeof R.createAsset.body>,
  ) {
    return respond(R.createAsset.response, await this.designs.createAsset(me.id, body));
  }

  @Post(R.completeAsset.path)
  @HttpCode(R.completeAsset.status)
  async completeAsset(
    @CurrentPhotographer() me: Photographer,
    @Param(new ZodPipe(R.completeAsset.params, 'params'))
    params: Out<typeof R.completeAsset.params>,
  ) {
    return respond(R.completeAsset.response, await this.designs.completeAsset(me.id, params.id));
  }

  @Get(R.getAsset.path)
  @HttpCode(R.getAsset.status)
  async getAsset(
    @CurrentPhotographer() me: Photographer,
    @Param(new ZodPipe(R.getAsset.params, 'params')) params: Out<typeof R.getAsset.params>,
  ) {
    return respond(R.getAsset.response, await this.designs.getAsset(me.id, params.id));
  }

  // --- designs ---------------------------------------------------------------------------------

  @Get(R.list.path)
  @HttpCode(R.list.status)
  async list(@CurrentPhotographer() me: Photographer) {
    return respond(R.list.response, await this.designs.list(me.id));
  }

  @Post(R.create.path)
  @HttpCode(R.create.status)
  async create(
    @CurrentPhotographer() me: Photographer,
    @Body(new ZodPipe(R.create.body, 'body')) body: Out<typeof R.create.body>,
  ) {
    return respond(R.create.response, await this.designs.create(me.id, body));
  }

  @Get(R.get.path)
  @HttpCode(R.get.status)
  async get(
    @CurrentPhotographer() me: Photographer,
    @Param(new ZodPipe(R.get.params, 'params')) params: Out<typeof R.get.params>,
  ) {
    return respond(R.get.response, await this.designs.get(me.id, params.id));
  }

  @Put(R.update.path)
  @HttpCode(R.update.status)
  async update(
    @CurrentPhotographer() me: Photographer,
    @Param(new ZodPipe(R.update.params, 'params')) params: Out<typeof R.update.params>,
    @Body(new ZodPipe(R.update.body, 'body')) body: Out<typeof R.update.body>,
  ) {
    return respond(R.update.response, await this.designs.update(me.id, params.id, body));
  }

  @Delete(R.delete.path)
  @HttpCode(R.delete.status)
  async delete(
    @CurrentPhotographer() me: Photographer,
    @Param(new ZodPipe(R.delete.params, 'params')) params: Out<typeof R.delete.params>,
  ): Promise<void> {
    await this.designs.delete(me.id, params.id);
  }

  @Post(R.setDefault.path)
  @HttpCode(R.setDefault.status)
  async setDefault(
    @CurrentPhotographer() me: Photographer,
    @Param(new ZodPipe(R.setDefault.params, 'params')) params: Out<typeof R.setDefault.params>,
  ): Promise<void> {
    await this.designs.setDefault(me.id, params.id);
  }

  @Delete(R.clearDefault.path)
  @HttpCode(R.clearDefault.status)
  async clearDefault(
    @CurrentPhotographer() me: Photographer,
    @Param(new ZodPipe(R.clearDefault.params, 'params'))
    params: Out<typeof R.clearDefault.params>,
  ): Promise<void> {
    await this.designs.clearDefault(me.id, params.id);
  }
}
