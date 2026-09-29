import {
  Controller,
  Post,
  Get,
  Body,
  Req,
  Res,
  UseGuards,
  UnauthorizedException,
} from "@nestjs/common";
import { Response } from "express";
import { AdminsAuthService } from "../services/admins-auth.service";
import { AdminsService } from "../services/admins.service";
import { AdminSignInDto } from "../dto/admin-sign-in.dto";
import {
  AdminGuard,
  ADMIN_ID_KEY,
  type AdminAuthenticatedRequest,
} from "../guards/admin.guard";
import type { Request } from "express";

const ADMIN_REFRESH_TOKEN_COOKIE = "adminRefreshToken";
const COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const IS_PROD = process.env.NODE_ENV === "production";

const ADMIN_AUTH_ERROR = {
  REFRESH_TOKEN_NOT_FOUND: "refresh_token_not_found",
} as const;

@Controller("admin")
export class AdminController {
  constructor(
    private readonly adminsAuthService: AdminsAuthService,
    private readonly adminsService: AdminsService,
  ) {}

  @Post("sign-in")
  async signIn(
    @Body() dto: AdminSignInDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.adminsAuthService.signIn(dto.email, dto.password);

    res.cookie(ADMIN_REFRESH_TOKEN_COOKIE, result.refreshToken, {
      httpOnly: true,
      maxAge: COOKIE_MAX_AGE_MS,
      path: "/",
      sameSite: IS_PROD ? "none" : "lax",
      secure: IS_PROD,
    });
    return {
      admin: result.admin,
      accessToken: result.accessToken,
    };
  }

  @Post("refresh")
  refresh(@Req() req: Request) {
    const cookies = req.cookies as
      | Record<string, string | undefined>
      | undefined;
    const refreshToken = cookies?.[ADMIN_REFRESH_TOKEN_COOKIE];
    if (typeof refreshToken !== "string") {
      throw new UnauthorizedException(ADMIN_AUTH_ERROR.REFRESH_TOKEN_NOT_FOUND);
    }
    const { accessToken } =
      this.adminsAuthService.refreshAccessToken(refreshToken);
    return { accessToken };
  }

  @Post("logout")
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(ADMIN_REFRESH_TOKEN_COOKIE, {
      path: "/",
      httpOnly: true,
      sameSite: IS_PROD ? "none" : "lax",
      secure: IS_PROD,
    });
    return { ok: true };
  }

  @Get("me")
  @UseGuards(AdminGuard)
  getMe(@Req() req: AdminAuthenticatedRequest) {
    const adminId = req[ADMIN_ID_KEY];
    return this.adminsService.getMe(adminId);
  }
}
