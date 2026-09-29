import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { USER_ID_KEY } from '../../users/guards/user.guard';
import { UserOrManagerGuard } from '../../users/guards/user-or-manager.guard';
import { CreateTelegramRecipientDto } from '../dto/create-telegram-recipient.dto';
import { ToggleTelegramRecipientDto } from '../dto/toggle-telegram-recipient.dto';
import { TelegramRecipientsService } from '../services/telegram-recipients.service';

@Controller('api/admin/telegram-recipients')
@UseGuards(UserOrManagerGuard(['Admin', 'Marketing']))
export class TelegramRecipientsController {
  constructor(private readonly telegramRecipientsService: TelegramRecipientsService) {}

  @Get()
  findAll(@Req() req: Request) {
    return this.telegramRecipientsService.findAllByUserId((req as any)[USER_ID_KEY] as string);
  }

  @Post()
  create(@Req() req: Request, @Body() dto: CreateTelegramRecipientDto) {
    return this.telegramRecipientsService.create((req as any)[USER_ID_KEY] as string, dto);
  }

  @Patch(':id/toggle')
  toggle(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ToggleTelegramRecipientDto,
  ) {
    return this.telegramRecipientsService.toggleNotifications(
      (req as any)[USER_ID_KEY] as string,
      id,
      dto.notificationsEnabled,
    );
  }

  @Delete(':id')
  remove(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    return this.telegramRecipientsService.remove((req as any)[USER_ID_KEY] as string, id);
  }
}
