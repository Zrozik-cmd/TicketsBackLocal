import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';

const ACCESS_TOKEN_TTL_SEC = 60 * 5;
const REFRESH_TOKEN_TTL_SEC = 60 * 60 * 24 * 365;

const INVALID_ACCESS_TOKEN = 'invalid_access_token';
const INVALID_REFRESH_TOKEN = 'invalid_refresh_token';

@Injectable()
export class ManagerAuthTokensHelper {
  static readonly AUDIENCE = 'manager';

  private readonly accessSecret: string;
  private readonly refreshSecret: string;

  constructor(private readonly config: ConfigService) {
    this.accessSecret = this.config.getOrThrow<string>('ACCESS_TOKEN_SECRET');
    this.refreshSecret = this.config.getOrThrow<string>('REFRESH_TOKEN_SECRET');
  }

  signAccessToken(managerId: string): string {
    return jwt.sign(
      { sub: managerId, aud: ManagerAuthTokensHelper.AUDIENCE },
      this.accessSecret,
      { expiresIn: ACCESS_TOKEN_TTL_SEC },
    );
  }

  signRefreshToken(managerId: string): string {
    return jwt.sign(
      { sub: managerId, aud: ManagerAuthTokensHelper.AUDIENCE },
      this.refreshSecret,
      { expiresIn: REFRESH_TOKEN_TTL_SEC },
    );
  }

  verifyAccessToken(token: string): { managerId: string } {
    try {
      const payload = jwt.verify(token, this.accessSecret) as { sub: string; aud?: string };
      if (payload.aud !== ManagerAuthTokensHelper.AUDIENCE) {
        throw new UnauthorizedException(INVALID_ACCESS_TOKEN);
      }
      return { managerId: payload.sub };
    } catch {
      throw new UnauthorizedException(INVALID_ACCESS_TOKEN);
    }
  }

  verifyRefreshToken(token: string): { managerId: string } {
    try {
      const payload = jwt.verify(token, this.refreshSecret) as { sub: string; aud?: string };
      if (payload.aud !== ManagerAuthTokensHelper.AUDIENCE) {
        throw new UnauthorizedException(INVALID_REFRESH_TOKEN);
      }
      return { managerId: payload.sub };
    } catch {
      throw new UnauthorizedException(INVALID_REFRESH_TOKEN);
    }
  }

  refreshAccessToken(refreshToken: string): { accessToken: string } {
    const { managerId } = this.verifyRefreshToken(refreshToken);
    return {
      accessToken: this.signAccessToken(managerId),
    };
  }
}
