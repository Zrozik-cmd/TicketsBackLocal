import {
  Controller,
  Post,
  Body,
  Get,
  Param,
  ParseIntPipe,
  BadRequestException,
  Logger,
  UsePipes,
  ValidationPipe,
  UseGuards,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { MockOrdersService } from './mock-orders.service';
import { CustomerAuthTokensHelper } from '../customers/customer-auth-tokens.helper';
import { CreateMockOrderDto } from './dto/create-mock-order.dto';
import { CreateFreePromoMockOrderDto } from './dto/create-free-promo-mock-order.dto';
import { CancelMockOrderDto } from './dto/cancel-mock-order.dto';
import { PaymentMicroserviceWebhookDto } from './dto/payment-microservice-webhook.dto';
import { CUSTOMER_ID_KEY, CustomerGuard } from '../customers/guards/customer.guard';
import { ResendOrderTicketsDto } from './dto/resend-order-tickets.dto';
import { ManualResendOrderTicketsDto } from './dto/manual-resend-order-tickets.dto';
import type { OmiseEventPayload } from './payment/omise-payment.types';
import { requestContext } from '../../utils/request-log.util';

@Controller('mock-orders')
export class MockOrdersController {
  private readonly logger = new Logger(MockOrdersController.name);

  constructor(
    private readonly mockOrdersService: MockOrdersService,
    private readonly customerAuthTokens: CustomerAuthTokensHelper,
  ) {}

  /**
   * Fee percents and rates for client-side totals (same basis as server: subtotal after promo).
   */
  @Get('events/:eventId/pricing-fees')
  getEventPricingFees(@Param('eventId', ParseIntPipe) eventId: number) {
    return this.mockOrdersService.getEventPricingFeesForCheckout(eventId);
  }

  /**
   * Paid order numbers only. Optional Bearer; invalid/missing token returns [].
   */
  @Get('order-ids')
  getOrderIdsForCustomer(@Req() req: Request): Promise<number[]> {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return Promise.resolve([]);
    }
    const token = authHeader.slice(7);
    let customerIdStr: string;
    try {
      ({ customerId: customerIdStr } = this.customerAuthTokens.verifyAccessToken(token));
    } catch {
      return Promise.resolve([]);
    }
    const customerId = Number(customerIdStr);
    if (Number.isNaN(customerId)) {
      return Promise.resolve([]);
    }
    return this.mockOrdersService.findOrderIdsByCustomerId(customerId);
  }

  @Post()
  @UseGuards(CustomerGuard)
  create(@Req() req: Request, @Body() dto: CreateMockOrderDto) {
    const customerId = Number((req as any)[CUSTOMER_ID_KEY]);
    /*
     * Pairs with "MockOrder created": an attempt line with no creation line right
     * after it means the order was refused during validation — a 400 the customer
     * sees as the generic "failed to create order" modal.
     */
    this.logger.log(
      `Checkout attempt customer=${customerId} event=${dto.event} currency=${dto.paymentCurrency ?? 'RUB'} method=${dto.omisePaymentMethod ?? '-'} lines=${dto.tickets?.length ?? 0} promo=${dto.promoCode ? 'yes' : 'no'} ${requestContext(req)}`,
    );
    return this.mockOrdersService.create(dto, customerId);
  }

  /**
   * Paid checkout without payment microservice: requires a promo with 100% percentage discount.
   * Same promo validation as POST /mock-orders; order is confirmed immediately (status paid, tickets issued).
   */
  @Post('promo100')
  @UseGuards(CustomerGuard)
  createFreePromo(@Req() req: Request, @Body() dto: CreateFreePromoMockOrderDto) {
    const customerId = Number((req as any)[CUSTOMER_ID_KEY]);
    return this.mockOrdersService.createFreeWithFullPromoOrder(dto, customerId);
  }

  /**
   * Polling endpoint for payment status checks.
   */
  @Get(':id/status')
  async getStatus(@Param('id', ParseIntPipe) id: number) {
    const order = await this.mockOrdersService.findById(id);
    return { id: order.id, status: order.status };
  }

  @Post('cancel')
  @UseGuards(CustomerGuard)
  async cancel(@Req() req: Request, @Body() dto: CancelMockOrderDto) {
    const customerId = Number((req as any)[CUSTOMER_ID_KEY]);
    const order = await this.mockOrdersService.cancelByCustomer(dto.orderId, customerId);
    return { id: order.id, status: order.status };
  }

  /**
   * Temporary unsafe endpoint for urgent manual confirmations from Postman.
   * No auth guard by request.
   */
  @Post('manual-confirm')
  async manualConfirm(@Body('orderId', ParseIntPipe) orderId: number) {
    const order = await this.mockOrdersService.confirmPayment(orderId);
    return { ok: true, id: order.id, status: order.status };
  }

  @Post(':id/resend-tickets')
  @UseGuards(CustomerGuard)
  resendTickets(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ResendOrderTicketsDto,
  ) {
    const customerId = Number((req as any)[CUSTOMER_ID_KEY]);
    return this.mockOrdersService.resendTicketsEmail(id, customerId, dto.locale);
  }

  /**
   * Manual resend to custom email. Does not change DB and does not re-issue tickets.
   */
  @Post('manual-resend-tickets')
  manualResendTickets(@Body() dto: ManualResendOrderTicketsDto) {
    return this.mockOrdersService.manualResendTicketsToEmail(
      dto.orderId,
      dto.email,
      dto.locale,
    );
  }

  @Post('omise/webhook')
  async omiseWebhook(@Body() event: OmiseEventPayload): Promise<{ ok: true }> {
    this.logger.log(
      `[OmiseWebhook] Received event key=${typeof event.key === 'string' ? event.key : 'unknown'} charge=${event.data?.id ?? 'unknown'}`,
    );
    return this.mockOrdersService.handleOmiseWebhook(event);
  }

  /**
   * Webhook от микросервиса оплаты (ARBIPAY → микросервис → этот URL).
   * В настройках клиента в микросервисе укажи webhookUrl: https://<твой-бэк>/mock-orders/webhook
   */
  @Post('webhook')
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
    }),
  )
  async paymentWebhook(@Body() dto: PaymentMicroserviceWebhookDto): Promise<{ ok: boolean }> {
    this.logger.log(
      `[Webhook] Получен вебхук оплаты: externalId=${dto.externalId} status=${dto.status} provider=${dto.provider} paymentStatus=${dto.paymentStatus ?? '—'} amount=${dto.amount ?? '—'} currency=${dto.currency ?? '—'}`,
    );

    const orderId = parseInt(dto.externalId, 10);
    if (Number.isNaN(orderId)) {
      this.logger.warn(`[Webhook] externalId не числовой (игнорируем или UUID): ${dto.externalId}`);
      this.logger.log(`[Webhook] Обработка завершена, ответ 200 OK`);
      return { ok: true };
    }

    const isSuccess =
      dto.status === 'completed' || dto.paymentStatus === 'SUCCESS';
    const isFailed = dto.status === 'failed';

    if (isSuccess) {
      try {
        await this.mockOrdersService.confirmPayment(orderId, {
          amount: dto.amount,
          currency: dto.currency,
          payload: dto.payload,
        });
        this.logger.log(`[Webhook] Заказ ${orderId} подтверждён (paid)`);
      } catch (e) {
        if (e instanceof BadRequestException) {
          this.logger.log(`[Webhook] Заказ ${orderId} уже обработан (идемпотентность), 200`);
        } else {
          throw e;
        }
      }
    } else if (isFailed) {
      try {
        await this.mockOrdersService.markPaymentFailed(orderId);
        this.logger.log(`[Webhook] Заказ ${orderId} помечен как failed`);
      } catch {
        this.logger.warn(`[Webhook] Заказ ${orderId} не найден при статусе failed`);
      }
    } else {
      this.logger.log(`[Webhook] Статус ${dto.status} / ${dto.paymentStatus ?? '—'} — без изменений заказа ${orderId}`);
    }

    this.logger.log(`[Webhook] Обработка завершена, ответ 200 OK`);
    return { ok: true };
  }
}
