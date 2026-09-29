import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { CASHIER_ARBI_ROLE } from './schemas/cashier-arbi.schema';

const ACCESS_TOKEN_TTL_SEC = 60 * 60 * 12;
const REFRESH_TOKEN_TTL_SEC = 60 * 60 * 24 * 365;
const INVALID_ACCESS_TOKEN = 'invalid_access_token';
const INVALID_REFRESH_TOKEN = 'invalid_refresh_token';

export type CashierArbiJwtPayload = {
  sub: string;
  aud: string;
  role: typeof CASHIER_ARBI_ROLE;
  email: string;
  pos_location: string;
};

@Injectable()
export class CashierArbiAuthTokensHelper {
  static readonly AUDIENCE = 'cashier-arbi';

  private readonly accessSecret: string;
  private readonly refreshSecret: string;

  constructor(private readonly config: ConfigService) {
    this.accessSecret = this.config.getOrThrow<string>('ACCESS_TOKEN_SECRET');
    this.refreshSecret = this.config.getOrThrow<string>('REFRESH_TOKEN_SECRET');
  }

  signAccessToken(params: { cashierId: string; email: string; posLocation: string }): string {
    return jwt.sign(
      {
        sub: params.cashierId,
        aud: CashierArbiAuthTokensHelper.AUDIENCE,
        role: CASHIER_ARBI_ROLE,
        email: params.email,
        pos_location: params.posLocation,
      },
      this.accessSecret,
      { expiresIn: ACCESS_TOKEN_TTL_SEC },
    );
  }

  signRefreshToken(cashierId: string): string {
    return jwt.sign(
      { sub: cashierId, aud: CashierArbiAuthTokensHelper.AUDIENCE },
      this.refreshSecret,
      { expiresIn: REFRESH_TOKEN_TTL_SEC },
    );
  }

  verifyAccessToken(token: string): CashierArbiJwtPayload {
    try {
      const payload = jwt.verify(token, this.accessSecret) as CashierArbiJwtPayload;
      if (
        payload.aud !== CashierArbiAuthTokensHelper.AUDIENCE ||
        payload.role !== CASHIER_ARBI_ROLE ||
        typeof payload.sub !== 'string' ||
        typeof payload.email !== 'string' ||
        typeof payload.pos_location !== 'string'
      ) {
        throw new UnauthorizedException(INVALID_ACCESS_TOKEN);
      }
      return payload;
    } catch {
      throw new UnauthorizedException(INVALID_ACCESS_TOKEN);
    }
  }

  verifyRefreshToken(token: string): { cashierId: string } {
    try {
      const payload = jwt.verify(token, this.refreshSecret) as { sub: string; aud?: string };
      if (payload.aud !== CashierArbiAuthTokensHelper.AUDIENCE || typeof payload.sub !== 'string') {
        throw new UnauthorizedException(INVALID_REFRESH_TOKEN);
      }
      return { cashierId: payload.sub };
    } catch {
      throw new UnauthorizedException(INVALID_REFRESH_TOKEN);
    }
  }
}
