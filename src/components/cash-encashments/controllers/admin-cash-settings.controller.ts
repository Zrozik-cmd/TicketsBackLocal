import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import {
  ADMIN_ID_KEY,
  AdminAuthenticatedRequest,
  AdminGuard,
} from '../../admin/guards/admin.guard';
import { CashEncashmentsService } from '../cash-encashments.service';
import { UpdateCashSettingsDto } from '../dto/update-cash-settings.dto';

/** Настройки кассы (страница «Статистика по точкам»): только админ. */
@Controller('admin/cash-settings')
@UseGuards(AdminGuard)
export class AdminCashSettingsController {
  constructor(private readonly cashEncashmentsService: CashEncashmentsService) {}

  @Get()
  get() {
    return this.cashEncashmentsService.getCashSettings();
  }

  /** Список получателей заменяется целиком — как его видит форма. */
  @Put()
  update(@Req() req: AdminAuthenticatedRequest, @Body() dto: UpdateCashSettingsDto) {
    return this.cashEncashmentsService.updateCashSettings(dto, req[ADMIN_ID_KEY]);
  }
}
