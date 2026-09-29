import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import mongoose from 'mongoose';
import { AdminAuthTokensHelper } from '../../admin/admin-auth-tokens.helper';
import {
  CashierArbiSchema,
  ICashierArbi,
} from '../../cashier-arbi/schemas/cashier-arbi.schema';
import {
  CashierArbiAuthTokensHelper,
  CashierArbiJwtPayload,
} from '../../cashier-arbi/cashier-arbi-auth-tokens.helper';

export const CASH_ORDERS_ACTOR_KEY = 'cashOrdersActor';

export type CashOrdersActor =
  | { type: 'Admin'; adminId: string }
  | {
      type: 'CashierArbi';
      cashierId: string;
      email: string;
      pos_location: string;
    };

@Injectable()
export class CashOrdersAccessGuard implements CanActivate {
  constructor(
    private readonly adminTokens: AdminAuthTokensHelper,
    private readonly cashierTokens: CashierArbiAuthTokensHelper,
  ) {}

  private get cashierModel(): mongoose.Model<ICashierArbi> {
    return (
      (mongoose.models.CashierArbi as mongoose.Model<ICashierArbi>) ??
      mongoose.model<ICashierArbi>('CashierArbi', CashierArbiSchema)
    );
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid Authorization header');
    }
    const token = authHeader.slice(7);

    try {
      const { adminId } = this.adminTokens.verifyAccessToken(token);
      (request as any)[CASH_ORDERS_ACTOR_KEY] = { type: 'Admin', adminId };
      return true;
    } catch {
      const adminTokenInvalid = true;
      void adminTokenInvalid;
    }

    let payload: CashierArbiJwtPayload | null = null;
    try {
      payload = this.cashierTokens.verifyAccessToken(token);
    } catch {
      const cashierTokenInvalid = true;
      void cashierTokenInvalid;
    }

    if (payload) {
      // Токен живёт 12 часов — деактивация должна действовать сразу, а не после его истечения.
      const cashier = await this.cashierModel
        .findOne({ id: Number(payload.sub) })
        .select('isActive')
        .lean()
        .exec();
      if (!cashier || cashier.isActive === false) {
        throw new UnauthorizedException('cashier_arbi_deactivated');
      }
      (request as any)[CASH_ORDERS_ACTOR_KEY] = {
        type: 'CashierArbi',
        cashierId: payload.sub,
        email: payload.email,
        pos_location: payload.pos_location,
      };
      return true;
    }

    throw new UnauthorizedException('Invalid access token');
  }
}
