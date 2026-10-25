import 'reflect-metadata';
import {
  Controller,
  type DynamicModule,
  Get,
  type INestApplication,
  Inject,
  Injectable,
  type LoggerService,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import express from 'express';
import { PhotographerGuard } from './auth/photographer.guard';
import type { ApiConfig } from './config';
import type { Db } from './db/db';
import { DriveController } from './drive/drive.controller';
import { DriveService } from './drive/drive.service';
import { DriveFileMapper } from './drive/media-urls';
import { ApiError } from './http/api-error';
import { ApiExceptionFilter, errorResponse } from './http/exception.filter';
import { jsonBodyMiddleware } from './http/json-body';
import {
  API_CONFIG,
  CLOCK,
  type Clock,
  DATABASE,
  MEDIA_URL_SIGNER,
  type MediaUrlSigner,
  OBJECT_STORAGE,
  type ObjectStorage,
  RATE_LIMITER,
  type RateLimiter,
  TOKEN_VERIFIER,
  type TokenVerifier,
} from './tokens';
import { UploadController } from './upload/upload.controller';
import { UploadService } from './upload/upload.service';

/** Everything the API needs from outside. main.ts wires real clients; tests pass fakes. */
export interface ApiDeps {
  config: ApiConfig;
  db: Db;
  storage: ObjectStorage;
  signer: MediaUrlSigner;
  rateLimiter: RateLimiter;
  tokenVerifier: TokenVerifier;
  clock: Clock;
  /** Closes pools and clients when the app shuts down. */
  onShutdown?: () => Promise<void>;
}

const SHUTDOWN = Symbol('SHUTDOWN');

@Controller()
class HealthController {
  /** ALB health check (`/api/health`). Liveness only: a database outage must not kill tasks. */
  @Get('/health')
  health() {
    return { status: 'ok' };
  }
}

@Injectable()
class ShutdownHook implements OnApplicationShutdown {
  constructor(@Inject(SHUTDOWN) private readonly close: () => Promise<void>) {}

  async onApplicationShutdown(): Promise<void> {
    await this.close();
  }
}

@Module({})
export class AppModule {
  static forRoot(deps: ApiDeps): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, DriveController, UploadController],
      providers: [
        { provide: API_CONFIG, useValue: deps.config },
        { provide: DATABASE, useValue: deps.db },
        { provide: OBJECT_STORAGE, useValue: deps.storage },
        { provide: MEDIA_URL_SIGNER, useValue: deps.signer },
        { provide: RATE_LIMITER, useValue: deps.rateLimiter },
        { provide: TOKEN_VERIFIER, useValue: deps.tokenVerifier },
        { provide: CLOCK, useValue: deps.clock },
        { provide: SHUTDOWN, useValue: deps.onShutdown ?? (() => Promise.resolve()) },
        ShutdownHook,
        PhotographerGuard,
        DriveFileMapper,
        DriveService,
        UploadService,
      ],
    };
  }
}

/**
 * Builds the API: global prefix `/api`, strict and case-sensitive routing (the WAF rules match
 * exact paths), JSON bodies with small limits, and one error format for everything.
 */
export async function createApiApp(
  deps: ApiDeps,
  logger: LoggerService | false = false,
): Promise<INestApplication> {
  const server = express();
  // Must be set before the first route is registered: Express creates its router lazily.
  server.set('case sensitive routing', true);
  server.set('strict routing', true);
  server.disable('x-powered-by');
  server.use(jsonBodyMiddleware(deps.config.limits));

  const app = await NestFactory.create(AppModule.forRoot(deps), new ExpressAdapter(server), {
    bodyParser: false,
    logger,
  });
  app.setGlobalPrefix('api');
  const filterLogger: LoggerService =
    logger === false
      ? { log: () => undefined, error: () => undefined, warn: () => undefined }
      : logger;
  app.useGlobalFilters(new ApiExceptionFilter(filterLogger));
  await app.init();
  // Nest's not-found handler only covers `/api/*`; everything else gets the same JSON 404
  // instead of Express's HTML page.
  server.use((_req: express.Request, res: express.Response) => {
    const { status, body } = errorResponse(new ApiError('NOT_FOUND', 'Not found'));
    res.status(status).json(body);
  });
  return app;
}
