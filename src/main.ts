import { HttpAdapterHost, NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { ValidationPipe } from '@nestjs/common'
import * as cookieParser from 'cookie-parser'
import * as express from 'express'
import { ConfigService } from '@nestjs/config'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { HttpExceptionLoggingFilter } from './filters/http-exception-logging.filter'

async function Start() {
  try {
    const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error', 'warn', 'log'] })
    // LINE webhooks are signed over the exact request bytes: keep that body raw (a Buffer).
    app.use('/integrations/line/webhook', express.raw({ type: '*/*', limit: '1mb' }))
    /*
     * The only JSON body limit in the app. Registered here, ahead of every other
     * middleware, so this is the parser that actually reads the stream: a second
     * express.json() added later never sees an unparsed body and cannot raise it.
     * Sized for base64 payloads — event covers and seating plans, and reviews
     * with up to 5 photos (the review form caps a submission at 8 MB).
     */
    app.useBodyParser('json', { limit: '12mb' })

    const config = app.get(ConfigService);
    const portRaw = config.get<string>('HTTP_PORT') ?? '5000';
    const port = parseInt(portRaw, 10) || 5000;
    const cors = config.get<string>('HTTP_CORS') ?? '*';
    const normalizeOrigin = (value: string) => value.trim().replace(/\/+$/, '').toLowerCase();
    const allowedOrigins = cors === '*'
      ? []
      : cors
          .split(',')
          .map((s) => normalizeOrigin(s))
          .filter(Boolean).concat('');
    allowedOrigins.push('https://admin.tickets.diil.me');
    // ### Глобальная ловушка для критических ошибок
    process.on('unhandledRejection', (reason) => {
      console.error('❌', reason);
    });

    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    );
    /*
     * Registered after the pipes so validation 400s are logged too. Logging only —
     * the default filter still writes the response, so no client sees a change.
     */
    const { httpAdapter } = app.get(HttpAdapterHost);
    app.useGlobalFilters(new HttpExceptionLoggingFilter(httpAdapter));

    app.enableCors({
      origin: (requestOrigin, callback) => {
        if (!requestOrigin) return callback(null, true);
        const normalized = normalizeOrigin(requestOrigin);
        if (cors === '*' || allowedOrigins.includes(normalized)) {
          return callback(null, true);
        }
        return callback(new Error(`CORS blocked for origin: ${requestOrigin}`), false);
      },
      credentials: true,
      methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With'],
      // The dashboard reads the ticket PDF's file name from it.
      exposedHeaders: ['Content-Disposition'],
      optionsSuccessStatus: 204,
      preflightContinue: false,
    });
    app.use(express.urlencoded({ limit: '12mb', extended: true }));
    app.use(cookieParser());

    await app.listen(port);
    console.log(`✅ Server started on port ${port}`);
    
  } catch (error) {
    console.log("App error", error);
  }
} 
Start();

//