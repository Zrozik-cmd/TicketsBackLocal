import {
  Injectable,
  BadRequestException,
  ConflictException,
  UnauthorizedException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import { RedisService } from '../../services/redis/redis.service';
import { NotificationService } from '../../services/NotificationService/notification.service';
import { ManagerAuthTokensHelper } from '../managers/manager-auth-tokens.helper';
import { ManagersAuthService } from '../managers/managers-auth.service';
import { ManagersService } from '../managers/managers.service';
import { UsersService } from './users.service';
import { UserAuthTokensHelper } from './user-auth-tokens.helper';
import { RegisterDto } from './dto/register.dto';

const VERIFY_CODE_TTL_SEC = 3600; // 1 hour

const REDIS_KEY_EMAIL = (email: string) => `verify:email:${email}`;
const REDIS_KEY_PHONE = (phoneNumber: string) => `verify:phone:${phoneNumber}`;

const USER_AUTH_ERROR = {
  USER_NOT_FOUND: 'user_not_found',
  EMAIL_ALREADY_REGISTERED: 'email_already_registered',
  PHONE_ALREADY_REGISTERED: 'phone_already_registered',
  TERMS_NOT_ACCEPTED: 'terms_not_accepted',
  INVALID_EMAIL_CODE: 'invalid_email_code',
  INVALID_PHONE_CODE: 'invalid_phone_code',
  GOOGLE_SIGN_IN_NOT_CONFIGURED: 'google_sign_in_not_configured',
  INVALID_GOOGLE_TOKEN: 'invalid_google_token',
  IDENTIFIER_REQUIRED: 'identifier_required',
  INVALID_CODE: 'invalid_code',
  MULTIPLE_MANAGER_ACCOUNTS: 'multiple_manager_accounts',
} as const;

function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    private readonly notification: NotificationService,
    private readonly usersService: UsersService,
    private readonly userAuthTokens: UserAuthTokensHelper,
    private readonly managerAuthTokens: ManagerAuthTokensHelper,
    @Inject(forwardRef(() => ManagersService))
    private readonly managersService: ManagersService,
    @Inject(forwardRef(() => ManagersAuthService))
    private readonly managersAuthService: ManagersAuthService,
  ) {}

  async sendEmailCode(email: string, forSignIn = false): Promise<{ ok: boolean }> {
    const e = email.trim();
    if (forSignIn) {
      const user = await this.usersService.findByEmailOrPhone(e, undefined);
      if (!user) {
        const manager = await this.managersService.findOneByEmail(e);
        if (!manager) {
          throw new UnauthorizedException(USER_AUTH_ERROR.USER_NOT_FOUND);
        }
      }
    } else {
      const existing = await this.usersService.findByEmailOrPhone(e, undefined);
      if (existing) {
        throw new ConflictException(USER_AUTH_ERROR.EMAIL_ALREADY_REGISTERED);
      }
      const managersWithEmail = await this.managersService.findManagersByEmail(e);
      if (managersWithEmail.length > 0) {
        throw new ConflictException(USER_AUTH_ERROR.EMAIL_ALREADY_REGISTERED);
      }
    }
    const code = generateCode();
    await this.redis.set(REDIS_KEY_EMAIL(e), code, VERIFY_CODE_TTL_SEC);
    await this.notification.sendEmailVerificationCode(e, code);
    return { ok: true };
  }

  async sendPhoneCode(phoneNumber: string, forSignIn = false): Promise<{ ok: boolean }> {
    const phone = phoneNumber.trim();
    if (forSignIn) {
      const user = await this.usersService.findByEmailOrPhone(undefined, phone);
      if (!user) {
        throw new UnauthorizedException(USER_AUTH_ERROR.USER_NOT_FOUND);
      }
    } else {
      const existing = await this.usersService.findByEmailOrPhone(undefined, phone);
      if (existing) {
        throw new ConflictException(USER_AUTH_ERROR.PHONE_ALREADY_REGISTERED);
      }
    }
    const code = generateCode();
    await this.redis.set(REDIS_KEY_PHONE(phone), code, VERIFY_CODE_TTL_SEC);
    await this.notification.sendPhoneVerificationCode(phone, code);
    return { ok: true };
  }

  async sendPaymentPhoneCode(phoneNumber: string): Promise<{ ok: boolean }> {
    const phone = phoneNumber.trim();
    const code = generateCode();
    await this.redis.set(REDIS_KEY_PHONE(phone), code, VERIFY_CODE_TTL_SEC);
    await this.notification.sendPhoneVerificationCode(phone, code);
    return { ok: true };
  }

  /** Check code only (does not consume). Used by verify-email-code endpoint. */
  async checkEmailCode(email: string, code: string): Promise<boolean> {
    const e = email.trim();
    const stored = await this.redis.get(REDIS_KEY_EMAIL(e));
    return stored === code;
  }

  /** Check code only (does not consume). Used by verify-phone-code endpoint. */
  async checkPhoneCode(phoneNumber: string, code: string): Promise<boolean> {
    const phone = phoneNumber.trim();
    const stored = await this.redis.get(REDIS_KEY_PHONE(phone));
    return stored === code;
  }

  private async verifyEmailCode(email: string, code: string): Promise<boolean> {
    const e = email.trim();
    const stored = await this.redis.get(REDIS_KEY_EMAIL(e));
    if (stored !== code) return false;
    await this.redis.del(REDIS_KEY_EMAIL(e));
    return true;
  }

  private async verifyPhoneCode(phoneNumber: string, code: string): Promise<boolean> {
    const phone = phoneNumber.trim();
    const stored = await this.redis.get(REDIS_KEY_PHONE(phone));
    if (stored !== code) return false;
    await this.redis.del(REDIS_KEY_PHONE(phone));
    return true;
  }

  async register(dto: RegisterDto) {
    if (!dto.termsAccepted) {
      throw new BadRequestException(USER_AUTH_ERROR.TERMS_NOT_ACCEPTED);
    }
    /*
     * Checked, not consumed: everything below can still fail — the other code
     * wrong, the phone already registered, a dropped connection — and a code
     * consumed here would turn every retry into "invalid email code" while the
     * person is holding exactly what the letter says. Redis is cleared only
     * once the account actually exists.
     */
    const [emailOk, phoneOk] = await Promise.all([
      this.checkEmailCode(dto.email, dto.emailCode),
      this.checkPhoneCode(dto.phoneNumber, dto.phoneCode),
    ]);
    if (!emailOk) {
      throw new BadRequestException(USER_AUTH_ERROR.INVALID_EMAIL_CODE);
    }
    if (!phoneOk) {
      throw new BadRequestException(USER_AUTH_ERROR.INVALID_PHONE_CODE);
    }
    const user = await this.usersService.create(dto);
    await Promise.all([
      this.redis.del(REDIS_KEY_EMAIL(dto.email.trim())),
      this.redis.del(REDIS_KEY_PHONE(dto.phoneNumber.trim())),
    ]);
    const userId = String((user as any).id);
    const accessToken = this.userAuthTokens.signAccessToken(userId);
    const refreshToken = this.userAuthTokens.signRefreshToken(userId);
    return {
      user: await this.usersService.getMe(userId),
      accessToken,
      refreshToken,
    };
  }

  refreshAccessToken(refreshToken: string): { accessToken: string } {
    try {
      const { userId } = this.userAuthTokens.verifyRefreshToken(refreshToken);
      return {
        accessToken: this.userAuthTokens.signAccessToken(userId),
      };
    } catch {
      return this.managersAuthService.refreshAccessToken(refreshToken);
    }
  }

  async signInWithGoogle(idToken: string) {
    const clientId = this.config.get<string>('GOOGLE_CLIENT_ID');
    if (!clientId) {
      throw new UnauthorizedException(USER_AUTH_ERROR.GOOGLE_SIGN_IN_NOT_CONFIGURED);
    }
    const client = new OAuth2Client(clientId);
    const ticket = await client.verifyIdToken({ idToken, audience: clientId });
    const payload = ticket.getPayload();
    if (!payload?.email) {
      throw new UnauthorizedException(USER_AUTH_ERROR.INVALID_GOOGLE_TOKEN);
    }
    const email = payload.email;
    const user = await this.usersService.findByEmailOrPhone(email, undefined);
    if (user) {
      const userId = String((user as any).id);
      const accessToken = this.userAuthTokens.signAccessToken(userId);
      const refreshToken = this.userAuthTokens.signRefreshToken(userId);
      return {
        kind: 'user' as const,
        user: await this.usersService.getMe(userId),
        accessToken,
        refreshToken,
      };
    }
    const managers = await this.managersService.findManagersByEmail(email);
    if (managers.length === 0) {
      throw new UnauthorizedException(USER_AUTH_ERROR.USER_NOT_FOUND);
    }
    if (managers.length > 1) {
      throw new BadRequestException(USER_AUTH_ERROR.MULTIPLE_MANAGER_ACCOUNTS);
    }
    const managerId = String(managers[0].id);
    const accessToken = this.managerAuthTokens.signAccessToken(managerId);
    const refreshToken = this.managerAuthTokens.signRefreshToken(managerId);
    return {
      kind: 'manager' as const,
      manager: await this.managersService.getMe(managerId),
      accessToken,
      refreshToken,
    };
  }

  async signInWithCode(dto: { email?: string; phoneNumber?: string; code: string }) {
    if (!dto.email && !dto.phoneNumber) {
      throw new BadRequestException(USER_AUTH_ERROR.IDENTIFIER_REQUIRED);
    }
    const user = await this.usersService.findByEmailOrPhone(dto.email, dto.phoneNumber);
    if (user) {
      let ok = false;
      if (dto.email) {
        ok = await this.verifyEmailCode(dto.email, dto.code);
      } else if (dto.phoneNumber) {
        ok = await this.verifyPhoneCode(dto.phoneNumber, dto.code);
      }
      if (!ok) {
        throw new UnauthorizedException(USER_AUTH_ERROR.INVALID_CODE);
      }
      const userId = String((user as any).id);
      const accessToken = this.userAuthTokens.signAccessToken(userId);
      const refreshToken = this.userAuthTokens.signRefreshToken(userId);
      return {
        kind: 'user' as const,
        user: await this.usersService.getMe(userId),
        accessToken,
        refreshToken,
      };
    }
    if (!dto.email?.trim()) {
      throw new UnauthorizedException(USER_AUTH_ERROR.USER_NOT_FOUND);
    }
    const manager = await this.managersService.findOneByEmail(dto.email);
    if (!manager) {
      throw new UnauthorizedException(USER_AUTH_ERROR.USER_NOT_FOUND);
    }

    const ok = await this.verifyEmailCode(dto.email, dto.code);
    if (!ok) {
      throw new UnauthorizedException(USER_AUTH_ERROR.INVALID_CODE);
    }

    const managerId = String(manager.id);
    const accessToken = this.managerAuthTokens.signAccessToken(managerId);
    const refreshToken = this.managerAuthTokens.signRefreshToken(managerId);
    return {
      kind: 'manager' as const,
      manager: await this.managersService.getMe(managerId),
      accessToken,
      refreshToken,
    };
  }
}
