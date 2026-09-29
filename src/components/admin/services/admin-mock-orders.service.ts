import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import mongoose from "mongoose";
import { ITicket, TicketSchema } from "../../tickets/schemas/ticket.schema";
import { IMockOrder, MockOrderSchema } from "@/components/mock-orders/schemas/mock-order.schema";
import { RefundMockOrdersDto } from "@/components/admin/dto/cancel-mock-orders.dto";
import { AdminsService } from "./admins.service";
import { CashEncashmentsService } from "../../cash-encashments/cash-encashments.service";
import { MockOrdersService } from "@/components/mock-orders/mock-orders.service";
import { EventsService } from "@/components/events/events.service";
import {
  buildRefundCalculation,
  buildRefundSnapshotFromCalculation,
} from "@/components/mock-orders/utils/mock-order-refund.util";
import {
  eventFeeRatesFromPercents,
  resolveEventFeePercents,
} from "@/components/events/utils/event-fee.util";
import type { MockOrderRefundActionResponse } from "@/components/mock-orders/dto/mock-order-refund-details.dto";
import { AdminResendOrderTicketsDto } from "@/components/admin/dto/resend-order-tickets.dto";

@Injectable()
export class AdminMockOrdersService {
  constructor(
    private readonly adminsService: AdminsService,
    private readonly mockOrdersService: MockOrdersService,
    private readonly eventsService: EventsService,
    private readonly cashEncashmentsService: CashEncashmentsService,
  ) {}

  private get mockOrderModel(): mongoose.Model<IMockOrder> {
    return (mongoose.models.MockOrder as mongoose.Model<IMockOrder>) ??
      mongoose.model<IMockOrder>('MockOrder', MockOrderSchema);
  }

  private get ticketModel(): mongoose.Model<ITicket> {
    return (mongoose.models.Ticket as mongoose.Model<ITicket>) ??
      mongoose.model<ITicket>('Ticket', TicketSchema);
  }

  private async resolveAdminEmail(adminId: string): Promise<string> {
    const admin = await this.adminsService.findByIdPublic(adminId);
    return admin?.email ?? adminId;
  }

  getRefundDetails(orderId: number) {
    return this.mockOrdersService.getMockOrderRefundDetailsAdmin(orderId);
  }

  resendTicketsToEmail(dto: AdminResendOrderTicketsDto) {
    return this.mockOrdersService.manualResendTicketsToEmail(
      dto.orderId,
      dto.email,
      dto.locale,
    );
  }

  async startRefundMockOrders(
    dto: RefundMockOrdersDto,
    adminId: string,
  ): Promise<MockOrderRefundActionResponse> {
    const order = await this.mockOrderModel.findOne({ id: dto.orderId }).exec();
    if (!order) {
      throw new NotFoundException(`MockOrder with id ${dto.orderId} not found`);
    }
    if (order.status !== 'paid') {
      throw new BadRequestException('refund_start_requires_paid_order');
    }
    if (!['none', 'cancelled'].includes(order.refundStatus)) {
      throw new BadRequestException('refund_already_in_progress_or_completed');
    }
    // if (
    //   order.paymentCurrency !== 'THB' &&
    //   (order.originalPaidAmount == null || Number(order.originalPaidAmount) <= 0)
    // ) {
    //   throw new BadRequestException('original_paid_amount_required_for_refund');
    // }

    const event = await this.eventsService.findOneByNumericId(order.event);
    const feeRates = eventFeeRatesFromPercents(resolveEventFeePercents(event));
    const calculation = buildRefundCalculation(order, feeRates);
    const adminEmail = await this.resolveAdminEmail(adminId);
    const now = new Date();

    order.refundStatus = 'refund_in_progress';
    order.refundStatusChangedByEmail = adminEmail;
    order.refund = buildRefundSnapshotFromCalculation(calculation, {
      status: 'refund_in_progress',
      createdAt: now,
      createdBy: adminEmail,
    });
    await order.save();

    return {
      success: true,
      orderStatus: order.status,
      refundStatus: order.refundStatus,
      refundStatusChangedByEmail: order.refundStatusChangedByEmail,
      refund: order.refund ?? null,
    };
  }

  async cancelMockOrderRefund(
    dto: RefundMockOrdersDto,
    adminId: string,
  ): Promise<MockOrderRefundActionResponse> {
    const order = await this.mockOrderModel.findOne({ id: dto.orderId }).exec();
    if (!order) {
      throw new NotFoundException(`MockOrder with id ${dto.orderId} not found`);
    }
    if (order.refundStatus !== 'refund_in_progress') {
      throw new BadRequestException('refund_cancel_requires_in_progress_status');
    }

    const adminEmail = await this.resolveAdminEmail(adminId);
    const now = new Date();

    order.status = 'paid';
    order.refundStatus = 'cancelled';
    order.refundStatusChangedByEmail = adminEmail;
    if (order.refund) {
      order.refund.status = 'cancelled';
      order.refund.cancelledAt = now;
      order.refund.cancelledBy = adminEmail;
    }
    await order.save();

    return {
      success: true,
      orderStatus: order.status,
      refundStatus: order.refundStatus,
      refundStatusChangedByEmail: order.refundStatusChangedByEmail,
      refund: order.refund ?? null,
    };
  }

  async completeRefundMockOrders(
    dto: RefundMockOrdersDto,
    adminId: string,
  ): Promise<MockOrderRefundActionResponse> {
    const order = await this.mockOrderModel.findOne({ id: dto.orderId }).exec();
    if (!order) {
      throw new NotFoundException(`MockOrder with id ${dto.orderId} not found`);
    }
    if (order.refundStatus !== 'refund_in_progress') {
      throw new BadRequestException('refund_complete_requires_in_progress_status');
    }

    const adminEmail = await this.resolveAdminEmail(adminId);
    const now = new Date();

    /*
     * Снимок билетов прямо перед удалением: реестр билетов организатора показывает их
     * как «возвращённые» (и по нему же сверяется поддельный PDF). Снимок записывается в
     * базу ДО удаления билетов, отдельным запросом: если дальше что-то упадёт, повторный
     * вызов найдёт его на месте (билетов к тому времени может уже не быть), а
     * существующий снимок условие `$exists: false` не затрёт. `order.save()` ниже поле
     * не трогает — в документе в памяти оно не меняется.
     */
    const issuedTickets = (await this.ticketModel
      .find({ orderId: order.id })
      .sort({ id: 1 })
      .lean()
      .exec()) as ITicket[];
    if (issuedTickets.length) {
      const snapshot = issuedTickets.map((ticket) => ({
        id: ticket.id,
        code: ticket.code,
        customer: ticket.customer,
        sector: ticket.sector,
        zone: ticket.zone,
        price: ticket.price,
        currency: ticket.currency,
        status: ticket.status,
        ...(typeof ticket.session === 'number'
          ? {
              session: ticket.session,
              sessionDate: ticket.sessionDate,
              sessionStart: ticket.sessionStart,
              sessionEnd: ticket.sessionEnd,
            }
          : {}),
        created: ticket.created,
      }));
      await this.mockOrderModel
        .updateOne(
          { id: order.id, refundedTickets: { $exists: false } },
          { $set: { refundedTickets: snapshot } },
          { runValidators: true },
        )
        .exec();
    }

    await this.ticketModel.deleteMany({ orderId: order.id }).exec();

    order.status = 'refunded';
    order.refundStatus = 'refunded';
    order.refundStatusChangedByEmail = adminEmail;
    order.tickets = [];
    if (order.refund) {
      order.refund.status = 'refunded';
      order.refund.completedAt = now;
      order.refund.completedBy = adminEmail;
    }
    await order.save();

    /*
     * Возврат наличного заказа — явная минус-строка в журнале кассы того, кто
     * принимал деньги. Историческая выручка больше не исчезает молча.
     */
    if (order.paymentMethod === 'CASH') {
      await this.cashEncashmentsService.recordRefund(
        order,
        order.refund?.refundAmount ?? order.total_price,
      );
    }

    return {
      success: true,
      orderStatus: order.status,
      refundStatus: order.refundStatus,
      refundStatusChangedByEmail: order.refundStatusChangedByEmail,
      refund: order.refund ?? null,
    };
  }
}
