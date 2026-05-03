import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';

@Catch()
export class ErrorLoggerFilter implements ExceptionFilter {
  private readonly logger = new Logger('UnhandledError');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<{ method: string; url: string }>();

    const isHttp = exception instanceof HttpException;
    const status = isHttp ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const body = isHttp ? exception.getResponse() : { statusCode: 500, message: 'Internal server error' };

    if (!isHttp || status >= 500) {
      const err = exception as Error;
      this.logger.error(`${req.method} ${req.url} -> ${status} :: ${err?.message}`, err?.stack);
      const cause = (err as unknown as { cause?: unknown })?.cause;
      if (cause) this.logger.error('cause:', cause);
    }

    res.status(status).json(typeof body === 'string' ? { statusCode: status, message: body } : body);
  }
}
