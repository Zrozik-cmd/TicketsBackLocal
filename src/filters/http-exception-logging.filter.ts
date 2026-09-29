import { ArgumentsHost, Catch, HttpException, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Request } from 'express';
import { requestContext } from '../utils/request-log.util';

/*
 * Nest answers 4xx without writing a single line to the log, so a customer who
 * cannot pay leaves no trace at all in `docker logs` — every checkout complaint
 * had to be reconstructed from the frontend. This filter only *logs* and then
 * hands the exception to the default filter, so response bodies stay byte-for-byte
 * identical for the site, the admin panel and the payment webhooks.
 *
 * Deliberately not AllExceptionsFilter (that one rewrites the body into a
 * different shape, which the clients' error parsing depends on).
 */
@Catch()
export class HttpExceptionLoggingFilter extends BaseExceptionFilter {
  private readonly logger = new Logger('HttpError');

  catch(exception: unknown, host: ArgumentsHost): void {
    /*
     * Logging runs inside the error path of every request, so it must never be
     * able to turn a plain 400 into a crashed one — an odd exception payload
     * that cannot be stringified is not worth a broken response.
     */
    try {
      if (host.getType() === 'http') {
        this.log(exception, host.switchToHttp().getRequest<Request>());
      }
    } catch {
      // Diagnostics are optional; the response below is not.
    }
    super.catch(exception, host);
  }

  private log(exception: unknown, req: Request): void {
    const status =
      exception instanceof HttpException ? exception.getStatus() : 500;
    const message = extractMessage(exception);

    // Bot scans for /wp-login.php and friends: no route, nothing to diagnose.
    if (status === 404 && message.startsWith('Cannot ')) return;

    const line = `${status} ${req.method} ${req.originalUrl} — ${message} ${requestContext(req)}`;

    if (status >= 500) {
      this.logger.error(line);
      if (exception instanceof Error && exception.stack) {
        this.logger.error(
          exception.stack.split('\n').slice(1, 4).map((l) => l.trim()).join(' | '),
        );
      }
      return;
    }
    this.logger.warn(line);
  }
}

function extractMessage(exception: unknown): string {
  if (exception instanceof HttpException) {
    const body = exception.getResponse();
    if (typeof body === 'string') return body;
    const message = (body as { message?: unknown }).message;
    if (Array.isArray(message)) return message.join('; ');
    if (typeof message === 'string') return message;
    return JSON.stringify(body);
  }
  if (exception instanceof Error) return exception.message;
  return String(exception);
}
