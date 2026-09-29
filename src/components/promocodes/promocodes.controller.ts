import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { CreatePromoCodeDto } from './dto/create-promo-code.dto';
import { PromoOrdersHistoryQueryDto } from './dto/promo-orders-history-query.dto';
import { UpdatePromoCodeDto } from './dto/update-promo-code.dto';
import { PromocodesService } from './promocodes.service';
import { USER_ID_KEY } from '../users/guards/user.guard';
import { UserOrManagerGuard } from '../users/guards/user-or-manager.guard';
import { MANAGER_ID_KEY } from '../managers/guards/manager.guard';
import { ManagersService } from '../managers/managers.service';

@Controller('promocodes')
export class PromocodesController {
  constructor(
    private readonly promocodesService: PromocodesService,
    private readonly managersService: ManagersService,
  ) {}

  private async getMarketingAssignedEventIds(req: Request): Promise<number[] | undefined> {
    const managerId = (req as any)[MANAGER_ID_KEY] as string | undefined;
    if (!managerId) {
      return undefined;
    }
    const manager = await this.managersService.findById(managerId);
    if (!manager || manager.type !== 'Marketing') {
      return undefined;
    }
    return this.managersService.getAssignedEventIds(managerId);
  }

  @UseGuards(UserOrManagerGuard(['Admin', 'Marketing']))
  @Get()
  async findAll(@Req() req: Request) {
    return this.promocodesService.findAll(
      (req as any)[USER_ID_KEY] as string,
      await this.getMarketingAssignedEventIds(req),
    );
  }

  @UseGuards(UserOrManagerGuard(['Admin', 'Marketing']))
  @Get('statistics')
  async statistics(@Req() req: Request) {
    return this.promocodesService.findStatistics(
      (req as any)[USER_ID_KEY] as string,
      await this.getMarketingAssignedEventIds(req),
    );
  }

  @UseGuards(UserOrManagerGuard(['Admin', 'Marketing']))
  @Get(':id/orders-history')
  async ordersHistory(
    @Req() req: Request,
    @Param('id') id: string,
    @Query() query: PromoOrdersHistoryQueryDto,
  ) {
    return this.promocodesService.findOrdersHistoryByPromoCode(
      id,
      (req as any)[USER_ID_KEY] as string,
      query.page,
      query.limit,
      await this.getMarketingAssignedEventIds(req),
    );
  }

  @UseGuards(UserOrManagerGuard(['Admin', 'Marketing']))
  @Get(':id')
  async findOne(@Req() req: Request, @Param('id') id: string) {
    return this.promocodesService.findOne(
      id,
      (req as any)[USER_ID_KEY] as string,
      await this.getMarketingAssignedEventIds(req),
    );
  }

  @UseGuards(UserOrManagerGuard(['Admin']))
  @Post()
  create(@Req() req: Request, @Body() dto: CreatePromoCodeDto) {
    return this.promocodesService.create(dto, (req as any)[USER_ID_KEY] as string);
  }

  @UseGuards(UserOrManagerGuard(['Admin']))
  @Patch(':id')
  update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdatePromoCodeDto,
  ) {
    return this.promocodesService.update(id, (req as any)[USER_ID_KEY] as string, dto);
  }

  @UseGuards(UserOrManagerGuard(['Admin']))
  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string) {
    await this.promocodesService.remove(id, (req as any)[USER_ID_KEY] as string);
  }
}
