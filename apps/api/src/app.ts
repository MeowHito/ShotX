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
import type { FaceProvider } from '@shotx/face';
import type { EmailProvider, PaymentGatewayAdapter } from '@shotx/shared';
import { AdminGuard } from './auth/admin.guard';
import { AdminSignIn } from './auth/admin-sign-in';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { BffGuard } from './auth/bff.guard';
import type { OidcDeps } from './auth/oidc';
import { PhotographerGuard, UserGuard } from './auth/photographer.guard';
import { createShotxAuth, SHOTX_AUTH } from './auth/shotx-auth';
import { CAPTCHA_VERIFIER, type CaptchaVerifier, TurnstileVerifier } from './public/captcha';
import { OriginGuard, PublicGuard } from './auth/public.guard';
import { BillingController } from './billing/billing.controller';
import { BillingService } from './billing/billing.service';
import { createEmailProvider } from './billing/email';
import { createPaymentGateway } from './billing/gateways';
import { WebhookService } from './billing/webhook.service';
import type { ApiConfig } from './config';
import { type EventLog, StdoutEventLog } from './infra/events';
import type { Db } from './db/db';
import { DriveController } from './drive/drive.controller';
import { DriveService } from './drive/drive.service';
import { DriveFileMapper } from './drive/media-urls';
import { StudioController } from './drive/studio.controller';
import { StudioService } from './drive/studio.service';
import { ApiError } from './http/api-error';
import { ApiExceptionFilter, errorResponse } from './http/exception.filter';
import { jsonBodyMiddleware } from './http/json-body';
import { MeController } from './me/me.controller';
import { MeService } from './me/me.service';
import { SignedUrls } from './media/signed-urls';
import { DownloadsService } from './public/downloads.service';
import { FaceService } from './public/face.service';
import { PublicShareController } from './public/public-share.controller';
import { SharePageService } from './public/share-page.service';
import { ShareAccess } from './share/share-access';
import { SharesController } from './share/shares.controller';
import { SharesService } from './share/shares.service';
import {
  API_CONFIG,
  API_LOGGER,
  CLOCK,
  type Clock,
  DATABASE,
  EMAIL_PROVIDER,
  EVENT_LOG,
  FACE_PROVIDER,
  KEY_VALUE_STORE,
  type KeyValueStore,
  MEDIA_URL_SIGNER,
  type MediaUrlSigner,
  OBJECT_STORAGE,
  type ObjectStorage,
  PAYMENT_GATEWAY,
  QUEUE_SENDER,
  type QueueSender,
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
  /** Redis in production: face-scan results, unlock proofs, viewer sessions. */
  store: KeyValueStore;
  queue: QueueSender;
  /** Rekognition (interactive profile) in production; FakeFaceProvider in tests. */
  faceProvider: FaceProvider;
  /** The PAYMENT_GATEWAY adapter; default createPaymentGateway(config). Tests pass the fake. */
  paymentGateway?: PaymentGatewayAdapter;
  /** The EMAIL_PROVIDER adapter; default createEmailProvider(config). Tests pass the fake. */
  email?: EmailProvider;
  /**
   * HTTP client and Google JWKS of the LINE/Google sign-in (AUTH_PROVIDER=shotx or local);
   * default: fetch and Google's remote JWKS. Tests pass local fakes (never the network).
   */
  oidc?: Partial<OidcDeps>;
  /**
   * Turnstile verification (CAPTCHA_PROVIDER=turnstile); default TurnstileVerifier on
   * siteverify. Tests pass FakeCaptchaVerifier (never the network).
   */
  captchaVerifier?: CaptchaVerifier;
  /** Structured alert events; default StdoutEventLog. Tests pass a MemoryEventLog. */
  events?: EventLog;
  /** Closes pools and clients when the app shuts down. */
  onShutdown?: () => Promise<void>;
}

const SHUTDOWN = Symbol('SHUTDOWN');

const SILENT_LOGGER: LoggerService = {
  log: () => undefined,
  error: () => undefined,
  warn: () => undefined,
};

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
  static forRoot(deps: ApiDeps, logger: LoggerService = SILENT_LOGGER): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController,
        DriveController,
        StudioController,
        UploadController,
        MeController,
        SharesController,
        PublicShareController,
        BillingController,
        AuthController,
      ],
      providers: [
        { provide: API_CONFIG, useValue: deps.config },
        { provide: DATABASE, useValue: deps.db },
        { provide: OBJECT_STORAGE, useValue: deps.storage },
        { provide: MEDIA_URL_SIGNER, useValue: deps.signer },
        { provide: RATE_LIMITER, useValue: deps.rateLimiter },
        { provide: TOKEN_VERIFIER, useValue: deps.tokenVerifier },
        { provide: CLOCK, useValue: deps.clock },
        { provide: KEY_VALUE_STORE, useValue: deps.store },
        { provide: QUEUE_SENDER, useValue: deps.queue },
        { provide: FACE_PROVIDER, useValue: deps.faceProvider },
        { provide: API_LOGGER, useValue: logger },
        {
          provide: EVENT_LOG,
          useValue: deps.events ?? new StdoutEventLog(() => deps.clock.now()),
        },
        {
          provide: PAYMENT_GATEWAY,
          useValue:
            deps.paymentGateway ?? createPaymentGateway(deps.config.paymentGateway, deps.clock),
        },
        { provide: EMAIL_PROVIDER, useValue: deps.email ?? createEmailProvider(deps.config.email) },
        { provide: SHOTX_AUTH, useValue: createShotxAuth(deps.config, deps.clock, deps.oidc) },
        {
          provide: CAPTCHA_VERIFIER,
          useValue:
            deps.config.captcha.provider === 'turnstile'
              ? (deps.captchaVerifier ?? new TurnstileVerifier(deps.config.captcha))
              : null,
        },
        { provide: SHUTDOWN, useValue: deps.onShutdown ?? (() => Promise.resolve()) },
        ShutdownHook,
        PhotographerGuard,
        UserGuard,
        PublicGuard,
        OriginGuard,
        SignedUrls,
        DriveFileMapper,
        DriveService,
        StudioService,
        UploadService,
        MeService,
        SharesService,
        ShareAccess,
        SharePageService,
        FaceService,
        DownloadsService,
        BillingService,
        WebhookService,
        BffGuard,
        AdminGuard,
        AuthService,
        AdminSignIn,
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

  const appLogger: LoggerService = logger === false ? SILENT_LOGGER : logger;
  const app = await NestFactory.create(
    AppModule.forRoot(deps, appLogger),
    new ExpressAdapter(server),
    { bodyParser: false, logger },
  );
  app.setGlobalPrefix('api');
  const filterLogger = appLogger;
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
