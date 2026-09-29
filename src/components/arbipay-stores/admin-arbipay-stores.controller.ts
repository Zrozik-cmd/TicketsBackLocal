import { Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../admin/guards/admin.guard';
import { ArbiPayStoresService } from './arbipay-stores.service';

/**
 * Точка ARBIPAY события в админке: посмотреть состояние и завести точку вручную
 * (события, опубликованные до включения модуля, и повтор после conflict/failed).
 * Регистрируется в AdminModule — там же, где AdminGuard.
 */
@Controller('admin/events')
@UseGuards(AdminGuard)
export class AdminArbiPayStoresController {
  constructor(private readonly arbiPayStoresService: ArbiPayStoresService) {}

  @Get(':id/arbipay-store')
  getState(@Param('id', ParseIntPipe) id: number) {
    return this.arbiPayStoresService.getAdminState(id);
  }

  @Post(':id/arbipay-store')
  create(@Param('id', ParseIntPipe) id: number) {
    return this.arbiPayStoresService.createStoreManually(id);
  }
}
