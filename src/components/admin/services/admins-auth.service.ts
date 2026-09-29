import {
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { AdminAuthTokensHelper } from "../admin-auth-tokens.helper";
import { AdminsService } from "./admins.service";

const ADMIN_AUTH_ERROR = {
  INVALID_CREDENTIALS: "invalid_credentials",
} as const;

@Injectable()
export class AdminsAuthService {
  private readonly logger = new Logger(AdminsAuthService.name);

  constructor(
    private readonly adminsService: AdminsService,
    private readonly adminAuthTokens: AdminAuthTokensHelper,
  ) {}

  refreshAccessToken(refreshToken: string): { accessToken: string } {
    return this.adminAuthTokens.refreshAccessToken(refreshToken);
  }

  async signIn(
    email: string,
    password: string,
  ): Promise<{ admin: unknown; accessToken: string; refreshToken: string }> {
    const admin = await this.adminsService.findByEmailWithPassword(email);

    const hash = admin?.passwordHash;
    if (!admin || !hash) {
      throw new UnauthorizedException(ADMIN_AUTH_ERROR.INVALID_CREDENTIALS);
    }
    const ok = await this.adminsService.validatePassword(password, hash);

    if (!ok) {
      throw new UnauthorizedException(ADMIN_AUTH_ERROR.INVALID_CREDENTIALS);
    }
    const adminId = String(admin.id);
    const accessToken = this.adminAuthTokens.signAccessToken(adminId);
    const refreshToken = this.adminAuthTokens.signRefreshToken(adminId);
    
    this.logger.log(`Admin signed in: ${admin.email}`);

    return {
      admin: await this.adminsService.getMe(adminId),
      accessToken,
      refreshToken,
    };
  }
}
