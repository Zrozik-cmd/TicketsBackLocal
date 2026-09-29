import {
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { CustomerGuard, CUSTOMER_ID_KEY } from '../customers/guards/customer.guard';
import { FavoritesService } from './favorites.service';

/** Per-customer saved events. All routes require a customer token. */
@Controller('favorites')
@UseGuards(CustomerGuard)
export class FavoritesController {
  constructor(private readonly favoritesService: FavoritesService) {}

  @Get()
  list(@Req() req: Request) {
    return this.favoritesService.list(this.customerId(req));
  }

  /** Just the ids — cheap enough to fetch on every event page for the like button. */
  @Get('ids')
  listIds(@Req() req: Request) {
    return this.favoritesService.listEventIds(this.customerId(req));
  }

  @Post(':eventId')
  add(@Req() req: Request, @Param('eventId', ParseIntPipe) eventId: number) {
    return this.favoritesService.add(this.customerId(req), eventId);
  }

  @Delete(':eventId')
  remove(@Req() req: Request, @Param('eventId', ParseIntPipe) eventId: number) {
    return this.favoritesService.remove(this.customerId(req), eventId);
  }

  private customerId(req: Request): number {
    return Number((req as any)[CUSTOMER_ID_KEY]);
  }
}
