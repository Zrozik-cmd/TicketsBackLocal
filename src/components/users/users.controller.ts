import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { MANAGER_TYPES } from '../managers/manager-type';
import { ManagersService } from '../managers/managers.service';
import { MANAGER_ID_KEY } from '../managers/guards/manager.guard';
import { UsersService } from './users.service';
import { USER_ID_KEY } from './guards/user.guard';
import { UserOrManagerGuard } from './guards/user-or-manager.guard';

@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly managersService: ManagersService,
  ) {}

  @Get('me')
  @UseGuards(UserOrManagerGuard([...MANAGER_TYPES]))
  async getMe(@Req() req: Request) {
    const authHeader = req.headers.authorization;
    const accessToken =
      authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    const userId = (req as any)[USER_ID_KEY] as string;
    const managerId = (req as any)[MANAGER_ID_KEY] as string | undefined;

    if (managerId) {
      const manager = await this.managersService.getMe(managerId);
      return {
        kind: 'manager' as const,
        user: null,
        manager,
        managerType: manager.type,
        accessToken,
      };
    }

    const user = await this.usersService.getMe(userId);
    return {
      kind: 'user' as const,
      user,
      manager: null,
      managerType: null,
      accessToken,
    };
  }
}
