import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { CustomerAuthTokensHelper } from '../customer-auth-tokens.helper';
import { requestContext } from '../../../utils/request-log.util';

export const CUSTOMER_ID_KEY = 'customerId';

@Injectable()
export class CustomerGuard implements CanActivate {
  private readonly logger = new Logger(CustomerGuard.name);

  constructor(private readonly customerAuthTokens: CustomerAuthTokensHelper) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      /*
       * The frontend keeps the access token in localStorage, so an in-app webview
       * that hands out fresh, empty storage sends no header at all. The customer
       * only sees the generic "failed to create order" modal, which is why this
       * case has to name itself in the log.
       */
      this.logger.warn(
        `401 no-bearer-header ${request.method} ${request.originalUrl} ${requestContext(request)}`,
      );
      throw new UnauthorizedException('Missing or invalid Authorization header');
    }
    const token = authHeader.slice(7);
    try {
      const { customerId } = this.customerAuthTokens.verifyAccessToken(token);
      (request as any)[CUSTOMER_ID_KEY] = customerId;
      return true;
    } catch (error) {
      this.logger.warn(
        `401 ${describeRejectedToken(token)} ${request.method} ${request.originalUrl} ${requestContext(request)}`,
      );
      throw error;
    }
  }
}

/**
 * Access tokens live 5 minutes and are refreshed through a SameSite=None cookie.
 * Saying how stale a rejected token is separates "the refresh cookie is being
 * dropped" from a forged, truncated or wrong-secret token.
 */
function describeRejectedToken(token: string): string {
  try {
    const payloadPart = token.split('.')[1];
    if (!payloadPart) return 'token-malformed';
    const payload = JSON.parse(
      Buffer.from(payloadPart, 'base64url').toString('utf8'),
    ) as { exp?: number };
    if (typeof payload.exp === 'number') {
      const staleSec = Math.round(Date.now() / 1000 - payload.exp);
      if (staleSec > 0) return `token-expired-${staleSec}s-ago`;
      return 'token-rejected-not-expired';
    }
    return 'token-rejected';
  } catch {
    return 'token-unparsable';
  }
}
