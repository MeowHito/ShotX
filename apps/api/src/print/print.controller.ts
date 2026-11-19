import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PRINT_ROUTES } from '@shotx/shared';
import type { z } from 'zod';
import {
  CurrentPhotographer,
  type Photographer,
  PhotographerGuard,
} from '../auth/photographer.guard';
import { CurrentPublic, type PublicContext, PublicGuard } from '../auth/public.guard';
import { respond, ZodPipe } from '../http/zod';
import { PrintService } from './print.service';

const R = PRINT_ROUTES;
type Out<T extends z.ZodType> = z.output<T>;

/**
 * The share page's PRINT_ROUTES (ADR 0031). `:token` is not validated by a pipe, like the other
 * public share routes: ShareAccess answers NOT_FOUND for malformed and unknown tokens alike.
 */
@Controller()
@UseGuards(PublicGuard)
export class PublicPrintController {
  constructor(@Inject(PrintService) private readonly print: PrintService) {}

  @Get(R.shareStatus.path)
  @HttpCode(R.shareStatus.status)
  async shareStatus(@CurrentPublic() ctx: PublicContext, @Param('token') token: string) {
    return respond(R.shareStatus.response, await this.print.shareStatus(token, ctx));
  }

  @Post(R.createOrder.path)
  @HttpCode(R.createOrder.status)
  async createOrder(
    @CurrentPublic() ctx: PublicContext,
    @Param('token') token: string,
    @Body(new ZodPipe(R.createOrder.body, 'body')) body: Out<typeof R.createOrder.body>,
  ) {
    return respond(R.createOrder.response, await this.print.createOrder(token, ctx, body));
  }
}

/** The studio's PRINT_ROUTES (ADR 0031), photographer only. */
@Controller()
@UseGuards(PhotographerGuard)
export class PrintController {
  constructor(@Inject(PrintService) private readonly print: PrintService) {}

  @Get(R.getSettings.path)
  @HttpCode(R.getSettings.status)
  async getSettings(@CurrentPhotographer() me: Photographer) {
    return respond(R.getSettings.response, await this.print.settings(me.id));
  }

  @Put(R.updateSettings.path)
  @HttpCode(R.updateSettings.status)
  async updateSettings(
    @CurrentPhotographer() me: Photographer,
    @Body(new ZodPipe(R.updateSettings.body, 'body')) body: Out<typeof R.updateSettings.body>,
  ) {
    return respond(R.updateSettings.response, await this.print.updateSettings(me.id, body));
  }

  @Get(R.listOrders.path)
  @HttpCode(R.listOrders.status)
  async listOrders(
    @CurrentPhotographer() me: Photographer,
    @Query(new ZodPipe(R.listOrders.query, 'query')) query: Out<typeof R.listOrders.query>,
  ) {
    return respond(R.listOrders.response, await this.print.listOrders(me.id, query.status));
  }

  @Post(R.approveOrder.path)
  @HttpCode(R.approveOrder.status)
  async approveOrder(
    @CurrentPhotographer() me: Photographer,
    @Param(new ZodPipe(R.approveOrder.params, 'params')) params: Out<typeof R.approveOrder.params>,
  ) {
    return respond(R.approveOrder.response, await this.print.approve(me.id, params.id));
  }

  @Post(R.rejectOrder.path)
  @HttpCode(R.rejectOrder.status)
  async rejectOrder(
    @CurrentPhotographer() me: Photographer,
    @Param(new ZodPipe(R.rejectOrder.params, 'params')) params: Out<typeof R.rejectOrder.params>,
  ) {
    return respond(R.rejectOrder.response, await this.print.reject(me.id, params.id));
  }

  @Post(R.printOrder.path)
  @HttpCode(R.printOrder.status)
  async printOrder(
    @CurrentPhotographer() me: Photographer,
    @Param(new ZodPipe(R.printOrder.params, 'params')) params: Out<typeof R.printOrder.params>,
    @Body(new ZodPipe(R.printOrder.body, 'body')) body: Out<typeof R.printOrder.body>,
  ) {
    return respond(
      R.printOrder.response,
      await this.print.print(me.id, params.id, body.onlyQueued),
    );
  }
}
