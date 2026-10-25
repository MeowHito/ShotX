import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { UPLOAD_ROUTES } from '@shotx/shared';
import type { z } from 'zod';
import {
  CurrentPhotographer,
  type Photographer,
  PhotographerGuard,
} from '../auth/photographer.guard';
import { respond, ZodPipe } from '../http/zod';
import { UploadService } from './upload.service';

const R = UPLOAD_ROUTES;
type Out<T extends z.ZodType> = z.output<T>;

/** UPLOAD_ROUTES. `:id` is the file id. File bytes never pass through here. */
@Controller()
@UseGuards(PhotographerGuard)
export class UploadController {
  constructor(@Inject(UploadService) private readonly uploads: UploadService) {}

  @Post(R.init.path)
  @HttpCode(R.init.status)
  async init(
    @CurrentPhotographer() me: Photographer,
    @Body(new ZodPipe(R.init.body, 'body')) body: Out<typeof R.init.body>,
  ) {
    return respond(R.init.response, await this.uploads.init(me.id, body));
  }

  @Post(R.signParts.path)
  @HttpCode(R.signParts.status)
  async signParts(
    @CurrentPhotographer() me: Photographer,
    @Param(new ZodPipe(R.signParts.params, 'params')) params: Out<typeof R.signParts.params>,
    @Body(new ZodPipe(R.signParts.body, 'body')) body: Out<typeof R.signParts.body>,
  ) {
    return respond(
      R.signParts.response,
      await this.uploads.signParts(me.id, params.id, body.partNumbers),
    );
  }

  @Get(R.listParts.path)
  @HttpCode(R.listParts.status)
  async listParts(
    @CurrentPhotographer() me: Photographer,
    @Param(new ZodPipe(R.listParts.params, 'params')) params: Out<typeof R.listParts.params>,
  ) {
    return respond(R.listParts.response, await this.uploads.listParts(me.id, params.id));
  }

  @Post(R.complete.path)
  @HttpCode(R.complete.status)
  async complete(
    @CurrentPhotographer() me: Photographer,
    @Param(new ZodPipe(R.complete.params, 'params')) params: Out<typeof R.complete.params>,
    @Body(new ZodPipe(R.complete.body, 'body')) body: Out<typeof R.complete.body>,
  ) {
    return respond(R.complete.response, await this.uploads.complete(me.id, params.id, body.parts));
  }

  @Delete(R.abort.path)
  @HttpCode(R.abort.status)
  async abort(
    @CurrentPhotographer() me: Photographer,
    @Param(new ZodPipe(R.abort.params, 'params')) params: Out<typeof R.abort.params>,
  ): Promise<void> {
    await this.uploads.abort(me.id, params.id);
  }
}
