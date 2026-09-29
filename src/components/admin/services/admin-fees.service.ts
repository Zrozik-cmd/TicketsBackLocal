import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import mongoose from 'mongoose';
import { UserSchema, IUser } from '../../users/schemas/user.schema';
import { EventSchema, IEvent } from '../../events/schemas/event.schema';
import { MockOrderSchema, IMockOrder } from '../../mock-orders/schemas/mock-order.schema';
import { resolveEventFeePercents } from '../../events/utils/event-fee.util';
import { ChangeUserDefaultFeePercentsDto } from '../dto/change-user-default-fee-percents.dto';
import { ChangeEventFeePercentsDto } from '../dto/change-event-fee-percents.dto';

@Injectable()
export class AdminFeesService {
  private get userModel(): mongoose.Model<IUser> {
    return (
      (mongoose.models.User as mongoose.Model<IUser>) ??
      mongoose.model<IUser>('User', UserSchema)
    );
  }

  private get eventModel(): mongoose.Model<IEvent> {
    return (
      (mongoose.models.Event as mongoose.Model<IEvent>) ??
      mongoose.model<IEvent>('Event', EventSchema)
    );
  }

  private get mockOrderModel(): mongoose.Model<IMockOrder> {
    return (
      (mongoose.models.MockOrder as mongoose.Model<IMockOrder>) ??
      mongoose.model<IMockOrder>('MockOrder', MockOrderSchema)
    );
  }

  async changeUserDefaultFeePercents(dto: ChangeUserDefaultFeePercentsDto): Promise<{
    userId: number;
    defaultVatPercent: number;
    defaultProcessingFeePercent: number;
    defaultPlatformFeePercent: number;
    defaultAdditionalTicketCostFeePercent: number;
  }> {
    const user = await this.userModel
      .findOneAndUpdate(
        { id: dto.userId },
        {
          $set: {
            defaultVatPercent: dto.defaultVatPercent,
            defaultProcessingFeePercent: dto.defaultProcessingFeePercent,
            defaultPlatformFeePercent: dto.defaultPlatformFeePercent,
            defaultAdditionalTicketCostFeePercent: dto.defaultAdditionalTicketCostFeePercent,
          },
        },
        { new: true },
      )
      .select([
        'id',
        'defaultVatPercent',
        'defaultProcessingFeePercent',
        'defaultPlatformFeePercent',
        'defaultAdditionalTicketCostFeePercent',
      ])
      .lean()
      .exec();

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return {
      userId: user.id,
      defaultVatPercent: user.defaultVatPercent as number,
      defaultProcessingFeePercent: user.defaultProcessingFeePercent as number,
      defaultPlatformFeePercent: user.defaultPlatformFeePercent as number,
      defaultAdditionalTicketCostFeePercent: user.defaultAdditionalTicketCostFeePercent as number,
    };
  }

  async changeEventFeePercents(dto: ChangeEventFeePercentsDto): Promise<{
    eventId: number;
    vatPercent: number;
    processingFeePercent: number;
    platformFeePercent: number;
    additionalTicketCostFeePercent: number;
    cashFeePercent: number;
  }> {
    const existing = await this.eventModel
      .findOne({ id: dto.eventId })
      .select(['id', 'vatPercent', 'additionalTicketCostFeePercent'])
      .lean<IEvent>()
      .exec();

    if (!existing) {
      throw new NotFoundException('Event not found');
    }

    const prev = resolveEventFeePercents(existing);
    const vatOrAdditionalChanged =
      dto.vatPercent !== prev.vatPercent ||
      dto.additionalTicketCostFeePercent !== prev.additionalTicketCostFeePercent;

    if (vatOrAdditionalChanged) {
      const blockingOrders = await this.mockOrderModel
        .countDocuments({
          event: dto.eventId,
          status: { $in: ['wait', 'paid'] },
        })
        .exec();
      if (blockingOrders > 0) {
        throw new BadRequestException(
          'vat_and_additional_ticket_cost_fee_cannot_change_while_event_has_wait_or_paid_orders',
        );
      }
    }

    const event = await this.eventModel
      .findOneAndUpdate(
        { id: dto.eventId },
        {
          $set: {
            vatPercent: dto.vatPercent,
            processingFeePercent: dto.processingFeePercent,
            platformFeePercent: dto.platformFeePercent,
            additionalTicketCostFeePercent: dto.additionalTicketCostFeePercent,
            ...(dto.cashFeePercent != null ? { cashFeePercent: dto.cashFeePercent } : {}),
          },
        },
        { new: true },
      )
      .select([
        'id',
        'vatPercent',
        'processingFeePercent',
        'platformFeePercent',
        'additionalTicketCostFeePercent',
        'cashFeePercent',
      ])
      .lean()
      .exec();

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    return {
      eventId: event.id,
      vatPercent: event.vatPercent as number,
      processingFeePercent: event.processingFeePercent as number,
      platformFeePercent: event.platformFeePercent as number,
      additionalTicketCostFeePercent: event.additionalTicketCostFeePercent as number,
      cashFeePercent: resolveEventFeePercents(event).cashFeePercent,
    };
  }
}
