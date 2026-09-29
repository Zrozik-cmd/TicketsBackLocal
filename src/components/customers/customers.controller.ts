import {
  Controller,
  Post,
  Body,
  Get,
  Patch,
  Req,
  Res,
  UseGuards,
  BadRequestException,
  UnauthorizedException,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { CustomersAuthService } from './customers-auth.service';
import { CustomersService } from './customers.service';
import { SendEmailCodeDto } from './dto/send-code.dto';
import { RegisterCustomerDto } from './dto/register-customer.dto';
import { VerifyEmailCodeDto } from './dto/verify-code.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { UpdateCustomerLastActivityDto } from './dto/update-customer-last-activity.dto';
import { SignInWithCodeDto } from './dto/sign-in-with-code.dto';
import { CheckoutAuthWithEmailDto } from './dto/checkout-auth-with-email.dto';
import { CustomerGuard, CUSTOMER_ID_KEY } from './guards/customer.guard';
import { requestContext } from '../../utils/request-log.util';

const CUSTOMER_REFRESH_TOKEN_COOKIE = 'customerRefreshToken';
const COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000; // 1 year
const IS_PROD = process.env.NODE_ENV === 'production';

const CUSTOMER_AUTH_ERROR = {
  INVALID_EMAIL_CODE: 'invalid_email_code',
  PHONE_AUTH_DEPRECATED: 'deprecated',
  REFRESH_TOKEN_NOT_FOUND: 'refresh_token_not_found',
} as const;

@Controller('customers')
export class CustomersController {
  private readonly logger = new Logger(CustomersController.name);

  constructor(
    private readonly customersAuthService: CustomersAuthService,
    private readonly customersService: CustomersService,
  ) {}

  @Post('send-email-code')
  async sendEmailCode(@Body() dto: SendEmailCodeDto) {
    await this.customersAuthService.sendEmailCode(dto.email, dto.forSignIn === true);
    return { ok: true };
  }

  @Post('send-phone-code')
  async sendPhoneCode() {
    throw new BadRequestException(CUSTOMER_AUTH_ERROR.PHONE_AUTH_DEPRECATED);
  }

  @Post('verify-email-code')
  async verifyEmailCode(@Body() dto: VerifyEmailCodeDto) {
    const valid = await this.customersAuthService.checkEmailCode(dto.email, dto.code);
    if (!valid) {
      throw new BadRequestException(CUSTOMER_AUTH_ERROR.INVALID_EMAIL_CODE);
    }
    return { ok: true };
  }

  @Post('verify-phone-code')
  async verifyPhoneCode() {
    throw new BadRequestException(CUSTOMER_AUTH_ERROR.PHONE_AUTH_DEPRECATED);
  }

  @Post('checkout-auth/send-code')
  async sendCodeForAuth(@Body() dto: SendEmailCodeDto) {
    await this.customersAuthService.sendCodeForAuth(dto.email);
    return { ok: true };
  }

  @Post('checkout-auth/verify-code')
  async verifyCodeForAuth(@Body() dto: VerifyEmailCodeDto) {
    const valid = await this.customersAuthService.verifyCodeForAuth(dto.email, dto.code);
    if (!valid) {
      throw new BadRequestException(CUSTOMER_AUTH_ERROR.INVALID_EMAIL_CODE);
    }
    return { ok: true };
  }

  @Post('checkout-auth/email')
  async authWithEmail(
    @Body() dto: CheckoutAuthWithEmailDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.customersAuthService.authWithEmail(dto);
    res.cookie(CUSTOMER_REFRESH_TOKEN_COOKIE, result.refreshToken, {
      httpOnly: true,
      maxAge: COOKIE_MAX_AGE_MS,
      path: '/',
      sameSite: IS_PROD ? 'none' : 'lax',
      secure: IS_PROD,
    });
    return {
      customer: result.customer,
      accessToken: result.accessToken,
    };
  }

  @Post('sign-in-with-code')
  async signInWithCode(
    @Body() dto: SignInWithCodeDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.customersAuthService.signInWithCode({
      email: dto.email,
      code: dto.code,
    });
    res.cookie(CUSTOMER_REFRESH_TOKEN_COOKIE, result.refreshToken, {
      httpOnly: true,
      maxAge: COOKIE_MAX_AGE_MS,
      path: '/',
      sameSite: IS_PROD ? 'none' : 'lax',
      secure: IS_PROD,
    });
    return {
      customer: result.customer,
      accessToken: result.accessToken,
    };
  }

  @Post('register')
  async register(
    @Body() dto: RegisterCustomerDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.customersAuthService.register(dto);
    res.cookie(CUSTOMER_REFRESH_TOKEN_COOKIE, result.refreshToken, {
      httpOnly: true,
      maxAge: COOKIE_MAX_AGE_MS,
      path: '/',
      sameSite: IS_PROD ? 'none' : 'lax',
      secure: IS_PROD,
    });
    return {
      customer: result.customer,
      accessToken: result.accessToken,
    };
  }

  @Post('refresh')
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const refreshToken = req.cookies?.[CUSTOMER_REFRESH_TOKEN_COOKIE];
    if (!refreshToken) {
      /*
       * The cookie is SameSite=None; Secure — exactly what iOS in-app browsers
       * drop. When it never comes back, the customer is silently signed out five
       * minutes after signing in, typically mid-checkout.
       */
      this.logger.warn(`refresh without cookie ${requestContext(req)}`);
      throw new UnauthorizedException(CUSTOMER_AUTH_ERROR.REFRESH_TOKEN_NOT_FOUND);
    }
    const { accessToken } = this.customersAuthService.refreshAccessToken(refreshToken);
    return { accessToken };
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(CUSTOMER_REFRESH_TOKEN_COOKIE, {
      path: '/',
      httpOnly: true,
      sameSite: IS_PROD ? 'none' : 'lax',
      secure: IS_PROD,
    });
    return { ok: true };
  }

  @Get('me')
  @UseGuards(CustomerGuard)
  getMe(@Req() req: Request) {
    const customerId = (req as any)[CUSTOMER_ID_KEY];
    return this.customersService.getMe(customerId);
  }

  @Patch('me/last-activity')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(CustomerGuard)
  async updateLastActivity(
    @Req() req: Request,
    @Body() dto: UpdateCustomerLastActivityDto,
  ): Promise<void> {
    const customerId = (req as any)[CUSTOMER_ID_KEY];
    await this.customersService.updateLastActivity(customerId, dto.lastActivity);
  }

  @Patch('me')
  @UseGuards(CustomerGuard)
  async updateMe(@Req() req: Request, @Body() dto: UpdateCustomerDto) {
    const customerId = (req as any)[CUSTOMER_ID_KEY];
    return this.customersService.updateFullname(customerId, dto.fullname);
  }
}
