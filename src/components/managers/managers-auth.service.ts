import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { RedisService } from '../../services/redis/redis.service';
import { ManagerAuthTokensHelper } from './manager-auth-tokens.helper';
import { ManagersService } from './managers.service';

const PIN_FAIL_LIMIT = 3;
const PIN_IP_BAN_TTL_SEC = 10 * 60;
const REDIS_KEY_PIN_FAIL = (ip: string) => `auth:manager:pin:fail:${ip}`;
const REDIS_KEY_PIN_BAN = (ip: string) => `auth:manager:pin:ban:${ip}`;

const MANAGER_AUTH_ERROR = {
  MANAGER_NOT_FOUND: 'manager_not_found',
  INVALID_PIN: 'invalid_pin',
  PIN_LOGIN_TEMPORARILY_BLOCKED: 'pin_login_temporarily_blocked',
  CASHIER_EVENT_NOT_ASSIGNED: 'cashier_event_not_assigned',
} as const;

@Injectable()
export class ManagersAuthService {
  constructor(
    private readonly redis: RedisService,
    private readonly managersService: ManagersService,
    private readonly managerAuthTokens: ManagerAuthTokensHelper,
  ) {}

  private normalizeIp(ip: string): string {
    return (ip ?? '').trim().toLowerCase() || 'unknown';
  }

  private async assertIpNotBanned(ip: string): Promise<void> {
    const blocked = await this.redis.get(REDIS_KEY_PIN_BAN(ip));
    if (blocked) {
      throw new UnauthorizedException(MANAGER_AUTH_ERROR.PIN_LOGIN_TEMPORARILY_BLOCKED);
    }
  }

  private async registerInvalidPinAttempt(ip: string): Promise<void> {
    const failKey = REDIS_KEY_PIN_FAIL(ip);
    const count = await this.redis.incr(failKey);
    if (count === 1) {
      await this.redis.expire(failKey, PIN_IP_BAN_TTL_SEC);
    }
    if (count >= PIN_FAIL_LIMIT) {
      await this.redis.set(REDIS_KEY_PIN_BAN(ip), '1', PIN_IP_BAN_TTL_SEC);
      await this.redis.del(failKey);
      throw new UnauthorizedException(MANAGER_AUTH_ERROR.PIN_LOGIN_TEMPORARILY_BLOCKED);
    }
    throw new UnauthorizedException(MANAGER_AUTH_ERROR.INVALID_PIN);
  }

  private async resetInvalidPinAttempts(ip: string): Promise<void> {
    await this.redis.del(REDIS_KEY_PIN_FAIL(ip));
  }

  refreshAccessToken(refreshToken: string): { accessToken: string } {
    return this.managerAuthTokens.refreshAccessToken(refreshToken);
  }

  async signInWithPin(dto: { pin: string; ip: string }) {
    const pin = dto.pin?.trim() ?? '';
    if (!pin) {
      throw new BadRequestException(MANAGER_AUTH_ERROR.INVALID_PIN);
    }
    const ip = this.normalizeIp(dto.ip);
    await this.assertIpNotBanned(ip);

    const manager = await this.managersService.findCashierByPin(pin);
    if (!manager) {
      await this.registerInvalidPinAttempt(ip);
      throw new UnauthorizedException(MANAGER_AUTH_ERROR.INVALID_PIN);
    }

    const managerId = String(manager.id);
    const assignedEventIds = await this.managersService.getAssignedEventIds(managerId);
    const availableEvents = await this.managersService.findActiveEventsForAssignedEventIds(assignedEventIds);
    if (!availableEvents.length) {
      throw new UnauthorizedException(MANAGER_AUTH_ERROR.CASHIER_EVENT_NOT_ASSIGNED);
    }

    await this.resetInvalidPinAttempts(ip);

    const accessToken = this.managerAuthTokens.signAccessToken(managerId);
    const refreshToken = this.managerAuthTokens.signRefreshToken(managerId);
    const selectedEventIdForProfile =
      assignedEventIds.length === 1 ? assignedEventIds[0] : null;
    return {
      manager: await this.managersService.getMe(managerId, selectedEventIdForProfile),
      availableEvents,
      accessToken,
      refreshToken,
    };
  }
}
