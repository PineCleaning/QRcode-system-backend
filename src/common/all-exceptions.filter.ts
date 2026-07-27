import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';

/**
 * NestJS already returns a safe generic 500 for uncaught non-HttpException
 * errors (it doesn't leak stack traces by default), but it doesn't
 * guarantee those get logged with useful context, and the response shape
 * wasn't guaranteed consistent with our normal { statusCode, message }
 * errors. This filter passes every HttpException through untouched
 * (preserves all existing 400/401/404/409 behavior across the app) and
 * only adds value for the unexpected case: log full details server-side,
 * return a safe generic message to the client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('UnhandledException');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<{ method: string; url: string }>();

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    this.logger.error(
      `Unhandled exception on ${request.method} ${request.url}: ${exception instanceof Error ? exception.stack : String(exception)}`,
    );

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Something went wrong. Please try again.',
    });
  }
}
