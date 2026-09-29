import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import * as jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { AdminAuthTokensHelper } from '../admin-auth-tokens.helper';
import {
  CashierArbiAuthTokensHelper,
  CashierArbiJwtPayload,
} from '../../cashier-arbi/cashier-arbi-auth-tokens.helper';
import { ManagerAuthTokensHelper } from '../../managers/manager-auth-tokens.helper';
import { ManagersService } from '../../managers/managers.service';
import { ADMIN_ID_KEY, AdminAuthenticatedRequest } from './admin.guard';
import {
  CashierArbiSchema,
  ICashierArbi,
} from '../../cashier-arbi/schemas/cashier-arbi.schema';

export const ADMIN_OR_CASHIER_ACTOR_KEY = 'adminOrCashierActor';

export type AdminOrCashierActor =
  | { type: 'Admin'; adminId: string }
  | {
      type: 'CashierArbi';
      cashierId: string;
      email: string;
      pos_location: string;
    }
  | { type: 'ManagerCashier'; managerId: string };

@Injectable()
export class AdminOrCashierArbiGuard implements CanActivate {
  constructor(
    private readonly adminTokens: AdminAuthTokensHelper,
    private readonly cashierTokens: CashierArbiAuthTokensHelper,
    private readonly managerTokens: ManagerAuthTokensHelper,
    private readonly managersService: ManagersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminAuthenticatedRequest>();
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid Authorization header');
    }
    const token = authHeader.slice(7);
    const decoded = jwt.decode(token) as { aud?: string } | null;
    const audience = typeof decoded?.aud === 'string' ? decoded.aud : '';

    if (audience === AdminAuthTokensHelper.AUDIENCE) {
      const { adminId } = this.adminTokens.verifyAccessToken(token);
      request[ADMIN_ID_KEY] = adminId;
      this.setActor(request, { type: 'Admin', adminId });
      return true;
    }

    if (audience === CashierArbiAuthTokensHelper.AUDIENCE) {
      const payload: CashierArbiJwtPayload = this.cashierTokens.verifyAccessToken(token);
      // Деактивация действует сразу, как и в CashOrdersAccessGuard.
      const cashierModel =
        (mongoose.models.CashierArbi as mongoose.Model<ICashierArbi>) ??
        mongoose.model<ICashierArbi>('CashierArbi', CashierArbiSchema);
      const cashier = await cashierModel
        .findOne({ id: Number(payload.sub) })
        .select('isActive')
        .lean()
        .exec();
      if (!cashier || cashier.isActive === false) {
        throw new UnauthorizedException('cashier_arbi_deactivated');
      }
      this.setActor(request, {
        type: 'CashierArbi',
        cashierId: payload.sub,
        email: payload.email,
        pos_location: payload.pos_location,
      });
      return true;
    }

    if (audience === ManagerAuthTokensHelper.AUDIENCE) {
      const { managerId } = this.managerTokens.verifyAccessToken(token);
      const manager = await this.managersService.findById(managerId);
      if (!manager || manager.type !== 'Cashier') {
        throw new UnauthorizedException('invalid_access_token');
      }
      this.setActor(request, { type: 'ManagerCashier', managerId });
      return true;
    }

    throw new UnauthorizedException('invalid_access_token');
  }

  private setActor(request: Request, actor: AdminOrCashierActor): void {
    (request as Request & Record<string, unknown>)[ADMIN_OR_CASHIER_ACTOR_KEY] = actor;
  }
}
