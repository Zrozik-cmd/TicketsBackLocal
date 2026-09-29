import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../../admin/guards/admin.guard';
import { CashEncashmentsService } from '../cash-encashments.service';
import { CreateCollectorDto } from '../dto/create-collector.dto';

/** Справочник инкассаторов ведёт только админ (страница «Кассиры»). */
@Controller('admin/cash-collectors')
@UseGuards(AdminGuard)
export class AdminCashCollectorsController {
  constructor(private readonly cashEncashmentsService: CashEncashmentsService) {}

  @Get()
  findAll() {
    return this.cashEncashmentsService.listCollectors();
  }

  @Post()
  create(@Body() dto: CreateCollectorDto) {
    return this.cashEncashmentsService.createCollector(dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.cashEncashmentsService.removeCollector(id);
  }
}
