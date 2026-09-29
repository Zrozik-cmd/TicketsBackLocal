import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;


    let message = 'Internal server error';
    let stackInfo = '';

    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      message =
        typeof response === 'string'
          ? response
          : (response as any)?.message || JSON.stringify(response);
    } else if (exception instanceof Error) {
      message = exception.message;
      if (exception.stack) {
        // Извлекаем 2-3 верхние строки из stack trace
        const stackLines = exception.stack.split('\n').slice(1, 4);
        stackInfo = stackLines.map(line => line.trim()).join(' | ');
      }
    }

    // Лог в консоль с указанием метода/файла
    this.logger.error(`🚨 Error occurred: ${message}`);
    if (stackInfo) {
      this.logger.error(`📍 Location (stack): ${stackInfo}`);
    }

    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      error: message,
    });
  }
}
