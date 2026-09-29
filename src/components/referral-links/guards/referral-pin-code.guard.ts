import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { RedisService } from '../../../services/redis/redis.service';
import {
  REFERRAL_CABINET_SESSION_COOKIE,
  referralCabinetSessionRedisKey,
} from '../constants/referral-cabinet-session.constants';

export const REFERRAL_CABINET_SESSION_LINK_ID_KEY = 'referralCabinetSessionLinkId';

@Injectable()
export class ReferralPinCodeGuard implements CanActivate {
  constructor(private readonly redis: RedisService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = request.cookies?.[REFERRAL_CABINET_SESSION_COOKIE]?.trim() ?? '';
    if (!token) {
      throw new UnauthorizedException('Missing or invalid referral cabinet session');
    }
    const linkId = await this.redis.get(referralCabinetSessionRedisKey(token));
    if (!linkId) {
      throw new UnauthorizedException('Invalid or expired cabinet session');
    }
    (request as any)[REFERRAL_CABINET_SESSION_LINK_ID_KEY] = linkId;
    return true;
  }
}
