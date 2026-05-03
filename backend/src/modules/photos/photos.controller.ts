import { BadRequestException, Controller, Get, Param, Post, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { CurrentUser, CurrentUserPayload } from '../../common/current-user';
import { JwtAuthGuard } from '../../common/jwt-auth.guard';
import { SubscriptionGuard } from '../../common/subscription.guard';
import { PhotosService } from './photos.service';

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25MB per file
const MAX_FILES_PER_REQUEST = 30;

@UseGuards(JwtAuthGuard)
@Controller('events/:eventId/photos')
export class PhotosController {
  constructor(private readonly photos: PhotosService) {}

  @Get()
  list(@Param('eventId') eventId: string) {
    return this.photos.list(eventId);
  }

  @Post()
  @UseGuards(SubscriptionGuard)
  @UseInterceptors(
    FilesInterceptor('files', MAX_FILES_PER_REQUEST, {
      limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES_PER_REQUEST },
    }),
  )
  upload(
    @CurrentUser() user: CurrentUserPayload,
    @Param('eventId') eventId: string,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    if (!files?.length) throw new BadRequestException('no_files_uploaded');
    for (const f of files) {
      if (!ALLOWED_MIME.has(f.mimetype)) throw new BadRequestException(`unsupported_mime: ${f.mimetype}`);
      if (f.size > MAX_FILE_BYTES) throw new BadRequestException(`file_too_large: ${f.originalname}`);
    }
    return this.photos.upload(user.sub, eventId, files);
  }
}
