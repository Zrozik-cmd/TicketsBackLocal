import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Type,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import * as jwt from 'jsonwebtoken';
import { ManagerAuthTokensHelper } from '../../managers/manager-auth-tokens.helper';
import { ManagerType } from '../../managers/manager-type';
import { ManagersService } from '../../managers/managers.service';
import { MANAGER_ID_KEY } from '../../managers/guards/manager.guard';
import { UserAuthTokensHelper } from '../user-auth-tokens.helper';
import { USER_ID_KEY } from './user.guard';

const MANAGER_OR_USER_GUARD_ERROR = {
  /** Manager document has no valid createdByUserId (organizer user id). */
  MISSING_CREATED_BY_USER: 'manager_missing_created_by_user',
} as const;

type AccessJwtPayload = { sub?: string; aud?: string };

export function UserOrManagerGuard(managerTypes: ManagerType[]): Type<CanActivate> {
  if (!Array.isArray(managerTypes) || managerTypes.length === 0) {
    throw new Error('UserOrManagerGuard requires a non-empty managerTypes array');
  }

  @Injectable()
  class UserOrManagerGuardHost implements CanActivate {
    constructor(
      private readonly config: ConfigService,
      private readonly managersService: ManagersService,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
      const request = context.switchToHttp().getRequest<Request>();
      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new UnauthorizedException('Missing or invalid Authorization header');
      }
      const token = authHeader.slice(7);
      const secret = this.config.getOrThrow<string>('ACCESS_TOKEN_SECRET');

      let payload: AccessJwtPayload;
      try {
        payload = jwt.verify(token, secret) as AccessJwtPayload;
      } catch {
        throw new UnauthorizedException('Invalid access token');
      }

      const aud = payload.aud;

      if (aud === UserAuthTokensHelper.AUDIENCE) {
        if (typeof payload.sub !== 'string' || !payload.sub) {
          throw new UnauthorizedException('Invalid access token');
        }
        (request as any)[USER_ID_KEY] = payload.sub;
        return true;
      }

      if (aud === ManagerAuthTokensHelper.AUDIENCE) {
        if (typeof payload.sub !== 'string' || !payload.sub) {
          throw new UnauthorizedException('Invalid access token');
        }
        (request as any)[MANAGER_ID_KEY] = payload.sub;

        const manager = await this.managersService.findById(payload.sub);
        if (!manager) {
          throw new UnauthorizedException('Manager not found');
        }
        if (!managerTypes.includes(manager.type as ManagerType)) {
          throw new ForbiddenException('Manager type is not allowed for this resource');
        }

        const createdByUserId = manager.createdByUserId;
        if (
          typeof createdByUserId !== 'number' ||
          !Number.isFinite(createdByUserId) ||
          createdByUserId <= 0
        ) {
          throw new ForbiddenException(MANAGER_OR_USER_GUARD_ERROR.MISSING_CREATED_BY_USER);
        }
        (request as any)[USER_ID_KEY] = String(createdByUserId);

        return true;
      }

      throw new UnauthorizedException('Invalid access token');
    }
  }

  return UserOrManagerGuardHost;
}
