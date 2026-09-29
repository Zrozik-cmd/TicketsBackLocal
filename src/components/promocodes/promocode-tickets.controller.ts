import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { CUSTOMER_ID_KEY, CustomerGuard } from '../customers/guards/customer.guard';
import { CheckPromoCodeForTicketDto } from './dto/check-promo-code-for-ticket.dto';
import { PromocodesService } from './promocodes.service';

/** Customer-authenticated promo validation during ticket purchase (price preview). */
@Controller('promocode-tickets')
export class PromocodeTicketsController {
  constructor(private readonly promocodesService: PromocodesService) {}

  @Post('check')
  @UseGuards(CustomerGuard)
  check(@Body() dto: CheckPromoCodeForTicketDto, @Req() req: { [CUSTOMER_ID_KEY]?: string }) {
    const customerId = Number(req[CUSTOMER_ID_KEY]);
    return this.promocodesService.checkPromoCodeForTicket(dto, customerId);
  }
}
