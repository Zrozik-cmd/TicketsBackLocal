import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Type,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { ManagerAuthTokensHelper } from '../manager-auth-tokens.helper';
import { ManagerType } from '../manager-type';
import { ManagersService } from '../managers.service';

export const MANAGER_ID_KEY = 'managerId';

export function ManagerGuard(types: ManagerType[]): Type<CanActivate> {
  if (!Array.isArray(types) || types.length === 0) {
    throw new Error('ManagerGuard requires a non-empty types array');
  }

  @Injectable()
  class ManagerGuardHost implements CanActivate {
    constructor(
      private readonly managerAuthTokens: ManagerAuthTokensHelper,
      private readonly managersService: ManagersService,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
      const request = context.switchToHttp().getRequest<Request>();
      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new UnauthorizedException('Missing or invalid Authorization header');
      }
      const token = authHeader.slice(7);
      const { managerId } = this.managerAuthTokens.verifyAccessToken(token);
      (request as any)[MANAGER_ID_KEY] = managerId;

      const manager = await this.managersService.findById(managerId);
      if (!manager) {
        throw new UnauthorizedException('Manager not found');
      }
      if (!types.includes(manager.type as ManagerType)) {
        throw new ForbiddenException('Manager type is not allowed for this resource');
      }

      return true;
    }
  }

  return ManagerGuardHost;
}
