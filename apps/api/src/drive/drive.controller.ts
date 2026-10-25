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
import { DRIVE_ROUTES } from '@shotx/shared';
import type { z } from 'zod';
import {
  CurrentPhotographer,
  type Photographer,
  PhotographerGuard,
} from '../auth/photographer.guard';
import { respond, ZodPipe } from '../http/zod';
import { DriveService } from './drive.service';

const R = DRIVE_ROUTES;
type Out<T extends z.ZodType> = z.output<T>;

/** DRIVE_ROUTES. Paths, statuses and schemas all come from the shared route table. */
@Controller()
@UseGuards(PhotographerGuard)
export class DriveController {
  constructor(@Inject(DriveService) private readonly drive: DriveService) {}

  @Get(R.listChildren.path)
  @HttpCode(R.listChildren.status)
  async listChildren(
    @CurrentPhotographer() me: Photographer,
    @Param(new ZodPipe(R.listChildren.params, 'params')) params: Out<typeof R.listChildren.params>,
    @Query(new ZodPipe(R.listChildren.query, 'query')) query: Out<typeof R.listChildren.query>,
  ) {
    return respond(R.listChildren.response, await this.drive.listChildren(me.id, params.id, query));
  }

  @Post(R.createFolder.path)
  @HttpCode(R.createFolder.status)
  async createFolder(
    @CurrentPhotographer() me: Photographer,
    @Body(new ZodPipe(R.createFolder.body, 'body')) body: Out<typeof R.createFolder.body>,
  ) {
    return respond(R.createFolder.response, await this.drive.createFolder(me.id, body));
  }

  @Patch(R.updateFolder.path)
  @HttpCode(R.updateFolder.status)
  async updateFolder(
    @CurrentPhotographer() me: Photographer,
    @Param(new ZodPipe(R.updateFolder.params, 'params')) params: Out<typeof R.updateFolder.params>,
    @Body(new ZodPipe(R.updateFolder.body, 'body')) body: Out<typeof R.updateFolder.body>,
  ) {
    return respond(R.updateFolder.response, await this.drive.updateFolder(me.id, params.id, body));
  }

  @Patch(R.updateFile.path)
  @HttpCode(R.updateFile.status)
  async updateFile(
    @CurrentPhotographer() me: Photographer,
    @Param(new ZodPipe(R.updateFile.params, 'params')) params: Out<typeof R.updateFile.params>,
    @Body(new ZodPipe(R.updateFile.body, 'body')) body: Out<typeof R.updateFile.body>,
  ) {
    return respond(R.updateFile.response, await this.drive.updateFile(me.id, params.id, body));
  }

  @Post(R.trashItems.path)
  @HttpCode(R.trashItems.status)
  async trashItems(
    @CurrentPhotographer() me: Photographer,
    @Body(new ZodPipe(R.trashItems.body, 'body')) body: Out<typeof R.trashItems.body>,
  ) {
    return respond(R.trashItems.response, await this.drive.trash(me.id, body.items));
  }

  @Post(R.restoreItems.path)
  @HttpCode(R.restoreItems.status)
  async restoreItems(
    @CurrentPhotographer() me: Photographer,
    @Body(new ZodPipe(R.restoreItems.body, 'body')) body: Out<typeof R.restoreItems.body>,
  ) {
    return respond(R.restoreItems.response, await this.drive.restore(me.id, body.items));
  }

  @Get(R.listTrash.path)
  @HttpCode(R.listTrash.status)
  async listTrash(
    @CurrentPhotographer() me: Photographer,
    @Query(new ZodPipe(R.listTrash.query, 'query')) query: Out<typeof R.listTrash.query>,
  ) {
    return respond(R.listTrash.response, await this.drive.listTrash(me.id, query));
  }

  @Delete(R.emptyTrash.path)
  @HttpCode(R.emptyTrash.status)
  async emptyTrash(@CurrentPhotographer() me: Photographer) {
    return respond(R.emptyTrash.response, await this.drive.emptyTrash(me.id));
  }

  @Get(R.usage.path)
  @HttpCode(R.usage.status)
  async usage(@CurrentPhotographer() me: Photographer) {
    return respond(R.usage.response, await this.drive.usage(me.id));
  }
}
