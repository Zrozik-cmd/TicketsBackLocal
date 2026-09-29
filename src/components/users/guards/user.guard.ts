import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { UserAuthTokensHelper } from '../user-auth-tokens.helper';

export const USER_ID_KEY = 'userId';

@Injectable()
export class UserGuard implements CanActivate {
  constructor(private readonly userAuthTokens: UserAuthTokensHelper) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid Authorization header');
    }
    const token = authHeader.slice(7);
    const { userId } = this.userAuthTokens.verifyAccessToken(token);
    (request as any)[USER_ID_KEY] = userId;
    return true;
  } 
}
