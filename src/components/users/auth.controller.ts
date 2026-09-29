import {
  Controller,
  Post,
  Body,
  Res,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { AuthService } from './auth.service';
import { SendEmailCodeDto, SendPhoneCodeDto } from './dto/send-code.dto';
import { VerifyEmailCodeDto, VerifyPhoneCodeDto } from './dto/verify-code.dto';
import { RegisterDto } from './dto/register.dto';
import { SignInWithCodeDto } from './dto/sign-in-with-code.dto';

const REFRESH_TOKEN_COOKIE = 'userRefreshToken';
const COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000; // 1 year
const IS_PROD = process.env.NODE_ENV === 'production';

const REFRESH_TOKEN_COOKIE_OPTIONS = {
  httpOnly: true,
  maxAge: COOKIE_MAX_AGE_MS,
  path: '/',
  sameSite: IS_PROD ? ('none' as const) : ('lax' as const),
  secure: IS_PROD,
};

const USER_AUTH_ERROR = {
  INVALID_EMAIL_CODE: 'invalid_email_code',
  INVALID_PHONE_CODE: 'invalid_phone_code',
  REFRESH_TOKEN_NOT_FOUND: 'refresh_token_not_found',
} as const;

@Controller('user/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('send-email-code')
  async sendEmailCode(@Body() dto: SendEmailCodeDto) {
    await this.authService.sendEmailCode(dto.email, dto.forSignIn === true);
    return { ok: true };
  }

  @Post('send-phone-code')
  async sendPhoneCode(@Body() dto: SendPhoneCodeDto) {
    await this.authService.sendPhoneCode(dto.phoneNumber, dto.forSignIn === true);
    return { ok: true };
  }

  @Post('verify-email-code')
  async verifyEmailCode(@Body() dto: VerifyEmailCodeDto) {
    const ok = await this.authService.checkEmailCode(dto.email, dto.code);
    if (!ok) {
      throw new UnauthorizedException(USER_AUTH_ERROR.INVALID_EMAIL_CODE);
    }
    return { ok: true };
  }

  @Post('verify-phone-code')
  async verifyPhoneCode(@Body() dto: VerifyPhoneCodeDto) {
    const ok = await this.authService.checkPhoneCode(dto.phoneNumber, dto.code);
    if (!ok) {
      throw new UnauthorizedException(USER_AUTH_ERROR.INVALID_PHONE_CODE);
    }
    return { ok: true };
  }

  @Post('register')
  async register(@Body() dto: RegisterDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.register(dto);
    res.cookie(REFRESH_TOKEN_COOKIE, result.refreshToken, REFRESH_TOKEN_COOKIE_OPTIONS);
    return {
      user: result.user,
      accessToken: result.accessToken,
    };
  }

  @Post('google')
  async google(@Body() body: { idToken: string }, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.signInWithGoogle(body.idToken);
    res.cookie(REFRESH_TOKEN_COOKIE, result.refreshToken, REFRESH_TOKEN_COOKIE_OPTIONS);
    return {
      kind: result.kind,
      user: result.kind === 'user' ? result.user : null,
      manager: result.kind === 'manager' ? result.manager : null,
      managerType: result.kind === 'manager' ? result.manager.type : null,
      accessToken: result.accessToken,
    };
  }

  @Post('sign-in-with-code')
  async signInWithCode(@Body() dto: SignInWithCodeDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.signInWithCode({
      email: dto.email,
      phoneNumber: dto.phoneNumber,
      code: dto.code,
    });
    res.cookie(REFRESH_TOKEN_COOKIE, result.refreshToken, REFRESH_TOKEN_COOKIE_OPTIONS);
    return {
      kind: result.kind,
      user: result.kind === 'user' ? result.user : null,
      manager: result.kind === 'manager' ? result.manager : null,
      managerType: result.kind === 'manager' ? result.manager.type : null,
      accessToken: result.accessToken,
    };
  }

  @Post('refresh')
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const refreshToken = req.cookies?.[REFRESH_TOKEN_COOKIE];
    if (!refreshToken) {
      throw new UnauthorizedException(USER_AUTH_ERROR.REFRESH_TOKEN_NOT_FOUND);
    }
    const { accessToken } = await this.authService.refreshAccessToken(refreshToken);
    return { accessToken };
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(REFRESH_TOKEN_COOKIE, {
      path: '/',
      httpOnly: true,
      sameSite: IS_PROD ? 'none' : 'lax',
      secure: IS_PROD,
    });
    return { ok: true };
  }
}
