import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../guards/admin.guard';
import { AdminFeesService } from '../services/admin-fees.service';
import { ChangeUserDefaultFeePercentsDto } from '../dto/change-user-default-fee-percents.dto';
import { ChangeEventFeePercentsDto } from '../dto/change-event-fee-percents.dto';

@Controller('admin/fees')
@UseGuards(AdminGuard)
export class AdminFeesController {
  constructor(private readonly adminFeesService: AdminFeesService) {}

  @Post('change-user-default-fee-percents')
  changeUserDefaultFeePercents(@Body() body: ChangeUserDefaultFeePercentsDto) {
    return this.adminFeesService.changeUserDefaultFeePercents(body);
  }

  @Post('change-event-fee-percents')
  changeEventFeePercents(@Body() body: ChangeEventFeePercentsDto) {
    return this.adminFeesService.changeEventFeePercents(body);
  }
}
