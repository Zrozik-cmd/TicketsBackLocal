import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import { RedisService } from '../../services/redis/redis.service';
import { NotificationService } from '../../services/NotificationService/notification.service';
import { CustomerAuthTokensHelper } from './customer-auth-tokens.helper';
import { CustomersService } from './customers.service';
import { RegisterCustomerDto } from './dto/register-customer.dto';
import { ReferralLinksService } from '../referral-links/referral-links.service';

const VERIFY_CODE_TTL_SEC = 3600; // 1 hour
const REDIS_KEY_EMAIL = (email: string) => `verify:customer:email:${email}`;
const REDIS_KEY_PHONE = (phone: string) => `verify:customer:phone:${phone}`;

const CUSTOMER_AUTH_ERROR = {
  CUSTOMER_NOT_FOUND: 'customer_not_found',
  EMAIL_ALREADY_REGISTERED: 'email_already_registered',
  PHONE_ALREADY_REGISTERED: 'phone_already_registered',
  TERMS_NOT_ACCEPTED: 'terms_not_accepted',
  INVALID_EMAIL_CODE: 'invalid_email_code',
  GOOGLE_SIGN_IN_NOT_CONFIGURED: 'google_sign_in_not_configured',
  INVALID_GOOGLE_TOKEN: 'invalid_google_token',
  REQUIRED_FIELDS_MISSING: 'required_fields_missing',
  IDENTIFIER_REQUIRED: 'identifier_required',
  INVALID_CODE: 'invalid_code',
} as const;

function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

@Injectable()
export class CustomersAuthService {
  private readonly logger = new Logger(CustomersAuthService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    private readonly notification: NotificationService,
    private readonly customersService: CustomersService,
    private readonly referralLinksService: ReferralLinksService,
    private readonly customerAuthTokens: CustomerAuthTokensHelper,
  ) {}

  /** Normalize email for Redis key (must match between send and verify). */
  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  /** Normalize phone for Redis key (must match between send and verify). */
  private normalizePhone(phone: string): string {
    return phone.trim();
  }

  async sendEmailCode(email: string, forSignIn = false): Promise<{ ok: boolean }> {
    const normalized = this.normalizeEmail(email);
    const existing = await this.customersService.findByEmail(normalized);
    if (forSignIn) {
      if (!existing) {
        throw new UnauthorizedException(CUSTOMER_AUTH_ERROR.CUSTOMER_NOT_FOUND);
      }
    } else {
      if (existing) {
        throw new BadRequestException(CUSTOMER_AUTH_ERROR.EMAIL_ALREADY_REGISTERED);
      }
    }
    const code = generateCode();
    await this.redis.set(REDIS_KEY_EMAIL(normalized), code, VERIFY_CODE_TTL_SEC);
    await this.notification.sendEmailVerificationCode(email, code);
    return { ok: true };
  }

  /**
   * Checkout auth flow: always send code regardless of whether customer already exists.
   */
  async sendCodeForAuth(email: string): Promise<{ ok: boolean }> {
    const normalized = this.normalizeEmail(email);
    const code = generateCode();
    await this.redis.set(REDIS_KEY_EMAIL(normalized), code, VERIFY_CODE_TTL_SEC);
    await this.notification.sendEmailVerificationCode(email, code);
    return { ok: true };
  }

  async sendPhoneCode(phone: string, forSignIn = false): Promise<{ ok: boolean }> {
    const normalized = this.normalizePhone(phone);
    const existing = await this.customersService.findByEmailOrPhone(undefined, normalized);
    if (forSignIn) {
      if (!existing) {
        throw new UnauthorizedException(CUSTOMER_AUTH_ERROR.CUSTOMER_NOT_FOUND);
      }
    } else {
      if (existing) {
        throw new BadRequestException(CUSTOMER_AUTH_ERROR.PHONE_ALREADY_REGISTERED);
      }
    }
    const code = generateCode();
    await this.redis.set(REDIS_KEY_PHONE(normalized), code, VERIFY_CODE_TTL_SEC);
    await this.notification.sendPhoneVerificationCode(phone, code);
    return { ok: true };
  }

  private async verifyEmailCode(email: string, code: string): Promise<boolean> {
    const normalized = this.normalizeEmail(email);
    const stored = await this.redis.get(REDIS_KEY_EMAIL(normalized));
    if (stored !== code) return false;
    await this.redis.del(REDIS_KEY_EMAIL(normalized));
    return true;
  }

  private async verifyPhoneCode(phone: string, code: string): Promise<boolean> {
    const normalized = this.normalizePhone(phone);
    const stored = await this.redis.get(REDIS_KEY_PHONE(normalized));
    if (stored !== code) return false;
    await this.redis.del(REDIS_KEY_PHONE(normalized));
    return true;
  }

  /** Check code without consuming it (for OTP modal). Same code is then used at register. */
  async checkEmailCode(email: string, code: string): Promise<boolean> {
    const normalized = this.normalizeEmail(email);
    const stored = await this.redis.get(REDIS_KEY_EMAIL(normalized));
    return stored === String(code).trim();
  }

  /** Checkout auth flow: check code without consuming it. */
  async verifyCodeForAuth(email: string, code: string): Promise<boolean> {
    return this.checkEmailCode(email, code);
  }

  /** Check code without consuming it (for OTP modal). Same code is then used at register. */
  async checkPhoneCode(phone: string, code: string): Promise<boolean> {
    const normalized = this.normalizePhone(phone);
    const stored = await this.redis.get(REDIS_KEY_PHONE(normalized));
    return stored === String(code).trim();
  }

  refreshAccessToken(refreshToken: string): { accessToken: string } {
    return this.customerAuthTokens.refreshAccessToken(refreshToken);
  }

  async register(dto: RegisterCustomerDto): Promise<{ customer: unknown; accessToken: string; refreshToken: string }> {
    if (dto.idToken) {
      return this.registerWithGoogle(dto.idToken, dto?.referralCode);
    }
    return this.registerManual(dto, dto?.referralCode);
  }

  private async registerWithGoogle(idToken: string, referralCode?: string): Promise<{ customer: unknown; accessToken: string; refreshToken: string }> {
    const clientId = this.config.get<string>('GOOGLE_CLIENT_ID');
    if (!clientId) {
      throw new UnauthorizedException(CUSTOMER_AUTH_ERROR.GOOGLE_SIGN_IN_NOT_CONFIGURED);
    }
    const client = new OAuth2Client(clientId);
    const ticket = await client.verifyIdToken({ idToken, audience: clientId });
    const payload = ticket.getPayload();
    if (!payload?.email) {
      throw new UnauthorizedException(CUSTOMER_AUTH_ERROR.INVALID_GOOGLE_TOKEN);
    }
    const fullname = payload.name || payload.email?.split('@')[0] || 'Customer';
    const email = payload.email;

    let customer = await this.customersService.findByEmail(email);
    if (!customer) {
      const referralLinkId = referralCode
        ? await this.referralLinksService.resolveReferralLinkForRegistration(referralCode)
        : undefined;
      customer = await this.customersService.create({
        fullname,
        email,
        referralLinkId,
      });
      if (referralLinkId) {
        await this.referralLinksService.incrementRegistrationsForReferralLink(
          referralLinkId,
        );
      }
    }
    const customerId = String((customer as any).id);
    const accessToken = this.customerAuthTokens.signAccessToken(customerId);
    const refreshToken = this.customerAuthTokens.signRefreshToken(customerId);
    this.logger.log(`Customer registered/signed in with Google: ${email}`);
    return {
      customer: await this.customersService.findById(customerId),
      accessToken,
      refreshToken,
    };
  }

  private async registerManual(dto: RegisterCustomerDto, referralCode?: string): Promise<{ customer: unknown; accessToken: string; refreshToken: string }> {
    if (!dto.termsAccepted) {
      throw new BadRequestException(CUSTOMER_AUTH_ERROR.TERMS_NOT_ACCEPTED);
    }
    if (!dto.fullname?.trim() || !dto.email?.trim() || dto.emailCode == null || String(dto.emailCode).trim().length !== 6) {
      throw new BadRequestException(CUSTOMER_AUTH_ERROR.REQUIRED_FIELDS_MISSING);
    }
    // Checked, not consumed — see the organizer register flow for the reasoning:
    // a create() failure after a consumed code would poison every retry.
    const emailOk = await this.checkEmailCode(dto.email.trim(), String(dto.emailCode).trim());
    if (!emailOk) {
      throw new BadRequestException(CUSTOMER_AUTH_ERROR.INVALID_EMAIL_CODE);
    }
    const referralLinkId = referralCode
      ? await this.referralLinksService.resolveReferralLinkForRegistration(referralCode)
      : undefined;
    const customer = await this.customersService.create({
      fullname: dto.fullname.trim(),
      email: dto.email.trim(),
      referralLinkId,
    });
    await this.redis.del(REDIS_KEY_EMAIL(this.normalizeEmail(dto.email)));
    if (referralLinkId) {
      await this.referralLinksService.incrementRegistrationsForReferralLink(
        referralLinkId,
      );
    }
    const customerId = String((customer as any).id);
    const accessToken = this.customerAuthTokens.signAccessToken(customerId);
    const refreshToken = this.customerAuthTokens.signRefreshToken(customerId);
    this.logger.log(`Customer registered: ${customer.email}`);
    return {
      customer: await this.customersService.findById(customerId),
      accessToken,
      refreshToken,
    };
  }

  async signInWithCode(dto: { email: string; code: string }): Promise<{ customer: unknown; accessToken: string; refreshToken: string }> {
    if (!dto.email?.trim()) {
      throw new BadRequestException(CUSTOMER_AUTH_ERROR.IDENTIFIER_REQUIRED);
    }
    const ok = await this.verifyEmailCode(dto.email.trim(), dto.code);
    if (!ok) {
      throw new UnauthorizedException(CUSTOMER_AUTH_ERROR.INVALID_CODE);
    }
    const customer = await this.customersService.findByEmail(dto.email.trim());
    if (!customer) {
      throw new UnauthorizedException(CUSTOMER_AUTH_ERROR.CUSTOMER_NOT_FOUND);
    }
    const customerId = String((customer as any).id);
    const accessToken = this.customerAuthTokens.signAccessToken(customerId);
    const refreshToken = this.customerAuthTokens.signRefreshToken(customerId);
    this.logger.log(`Customer signed in: ${customer.email}`);
    return {
      customer: await this.customersService.findById(customerId),
      accessToken,
      refreshToken,
    };
  }

  /**
   * Checkout auth flow:
   * - verifies OTP
   * - signs in existing customer by email
   * - or creates a new one and signs in
   */
  async authWithEmail(dto: {
    email: string;
    code: string;
    fullname?: string;
    referralCode?: string;
  }): Promise<{ customer: unknown; accessToken: string; refreshToken: string }> {
    const email = this.normalizeEmail(dto.email);
    const code = String(dto.code ?? '').trim();

    const ok = await this.verifyEmailCode(email, code);
    if (!ok) {
      throw new BadRequestException(CUSTOMER_AUTH_ERROR.INVALID_EMAIL_CODE);
    }

    const existingCustomer = await this.customersService.findByEmail(email);
    if (existingCustomer) {
      const customerId = String((existingCustomer as any).id);
      const accessToken = this.customerAuthTokens.signAccessToken(customerId);
      const refreshToken = this.customerAuthTokens.signRefreshToken(customerId);
      this.logger.log(`Customer signed in via checkout auth: ${email}`);
      return {
        customer: await this.customersService.findById(customerId),
        accessToken,
        refreshToken,
      };
    }

    const fullname = dto.fullname?.trim();
    if (!fullname) {
      throw new BadRequestException(CUSTOMER_AUTH_ERROR.REQUIRED_FIELDS_MISSING);
    }

    const referralLinkId = dto.referralCode
      ? await this.referralLinksService.resolveReferralLinkForRegistration(dto.referralCode)
      : undefined;

    let createdCustomer: unknown;
    try {
      createdCustomer = await this.customersService.create({
        fullname,
        email,
        referralLinkId,
      });
      if (referralLinkId) {
        await this.referralLinksService.incrementRegistrationsForReferralLink(
          referralLinkId,
        );
      }
    } catch (error) {
      const racedCustomer = await this.customersService.findByEmail(email);
      if (!racedCustomer) {
        throw error;
      }
      const customerId = String((racedCustomer as any).id);
      const accessToken = this.customerAuthTokens.signAccessToken(customerId);
      const refreshToken = this.customerAuthTokens.signRefreshToken(customerId);
      this.logger.log(`Customer signed in via checkout auth after race: ${email}`);
      return {
        customer: await this.customersService.findById(customerId),
        accessToken,
        refreshToken,
      };
    }

    const customerId = String((createdCustomer as any).id);
    const accessToken = this.customerAuthTokens.signAccessToken(customerId);
    const refreshToken = this.customerAuthTokens.signRefreshToken(customerId);
    this.logger.log(`Customer registered via checkout auth: ${email}`);
    return {
      customer: await this.customersService.findById(customerId),
      accessToken,
      refreshToken,
    };
  }
}
