import { Body, Controller, Get, Param, Post, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import type { Request, Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { RateLimit, RateLimitGuard } from '../../common/rate-limit.guard';
import { GuestService } from './guest.service';

@Controller('guest')
export class GuestController {
  constructor(private readonly guest: GuestService) {}

  @Get('events/:slug')
  getEvent(@Param('slug') slug: string) {
    return this.guest.getEvent(slug);
  }

  @Get('events/:slug/photos')
  listPhotos(@Param('slug') slug: string) {
    return this.guest.listPhotos(slug);
  }

  @Post('events/:slug/search')
  @UseGuards(RateLimitGuard)
  @RateLimit({ ttlMs: 60_000, limit: 6, keyPrefix: 'guest:face-search' })
  @UseInterceptors(FileInterceptor('selfie'))
  search(
    @Param('slug') slug: string,
    @UploadedFile() selfie: Express.Multer.File,
    @Body('session_id') sessionId?: string,
  ) {
    return this.guest.searchByFace(slug, selfie, sessionId);
  }

  @Get('events/:slug/photos/:photoId/download')
  @UseGuards(RateLimitGuard)
  @RateLimit({ ttlMs: 60_000, limit: 30, keyPrefix: 'guest:download' })
  async download(
    @Param('slug') slug: string,
    @Param('photoId') photoId: string,
    @Query('session_id') sessionId: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const result = await this.guest.downloadPhoto(slug, photoId, sessionId, req.ip);
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(result.filename)}"`);
    res.setHeader('Cache-Control', 'private, max-age=0, no-store');
    res.send(result.buffer);
  }
}
