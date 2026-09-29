import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../../admin/guards/admin.guard';
import { CashierArbiService } from '../cashier-arbi.service';
import { CreateCashierArbiDto } from '../dto/create-cashier-arbi.dto';
import { SetCashierActiveDto } from '../dto/set-cashier-active.dto';
import { UpdateCashierArbiDto } from '../dto/update-cashier-arbi.dto';

@Controller('admin/cashiers')
@UseGuards(AdminGuard)
export class AdminCashiersController {
  constructor(private readonly cashierArbiService: CashierArbiService) {}

  @Get()
  findAll() {
    return this.cashierArbiService.findAll();
  }

  @Post()
  create(@Body() dto: CreateCashierArbiDto) {
    return this.cashierArbiService.create(dto);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCashierArbiDto,
  ) {
    return this.cashierArbiService.update(id, dto);
  }

  @Patch(':id/active')
  setActive(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetCashierActiveDto,
  ) {
    return this.cashierArbiService.setActive(id, dto.active);
  }
}
