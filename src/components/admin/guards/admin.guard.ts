import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Request } from "express";
import { AdminAuthTokensHelper } from "../admin-auth-tokens.helper";

export const ADMIN_ID_KEY = "adminId";

export type AdminAuthenticatedRequest = Request & {
  [ADMIN_ID_KEY]: string;
};

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly adminAuthTokens: AdminAuthTokensHelper) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<AdminAuthenticatedRequest>();
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new UnauthorizedException(
        "Missing or invalid Authorization header",
      );
    }
    const token = authHeader.slice(7);
    const { adminId } = this.adminAuthTokens.verifyAccessToken(token);
    request[ADMIN_ID_KEY] = adminId;
    return true;
  }
}
