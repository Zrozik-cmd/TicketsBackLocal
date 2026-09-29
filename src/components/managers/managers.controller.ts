import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { USER_ID_KEY } from '../users/guards/user.guard';
import { CreateManagerDto } from './dto/create-manager.dto';
import { UpdateManagerDto } from './dto/update-manager.dto';
import { ManagerGuard, MANAGER_ID_KEY } from './guards/manager.guard';
import { MANAGER_TYPES } from './manager-type';
import { ManagersService } from './managers.service';
import { UserOrManagerGuard } from '../users/guards/user-or-manager.guard';

@Controller('managers')
export class ManagersController {
  constructor(private readonly managersService: ManagersService) {}

  private assertAccessManagementPermissions(req: Request): void {
    const managerId = (req as any)[MANAGER_ID_KEY] as string | undefined;
    if (managerId) {
      throw new ForbiddenException('insufficient_permissions_for_access_management');
    }
  }

  @Get()
  @UseGuards(UserOrManagerGuard(['Admin']))
  findAll(@Req() req: Request) {
    const userId = (req as any)[USER_ID_KEY] as string;
    return this.managersService.findAllForOrganizer(userId);
  }

  @Post()
  @UseGuards(UserOrManagerGuard(['Admin']))
  create(@Req() req: Request, @Body() dto: CreateManagerDto) {
    this.assertAccessManagementPermissions(req);
    const userId = (req as any)[USER_ID_KEY] as string;
    return this.managersService.create(dto, userId);
  }

  @Patch(':id')
  @UseGuards(UserOrManagerGuard(['Admin']))
  update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateManagerDto) {
    this.assertAccessManagementPermissions(req);
    const userId = (req as any)[USER_ID_KEY] as string;
    return this.managersService.update(id, dto, userId);
  }

  @Delete(':id')
  @UseGuards(UserOrManagerGuard(['Admin']))
  remove(@Req() req: Request, @Param('id') id: string) {
    this.assertAccessManagementPermissions(req);
    const userId = (req as any)[USER_ID_KEY] as string;
    return this.managersService.remove(id, userId);
  }

  @Get('me/:eventId')
  @UseGuards(ManagerGuard([...MANAGER_TYPES]))
  getMe(@Req() req: Request, @Param('eventId', ParseIntPipe) eventId: number) {
    const managerId = (req as any)[MANAGER_ID_KEY] as string;
    return this.managersService.getMe(managerId, eventId);
  }
}
