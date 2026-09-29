import { NotFoundException } from '@nestjs/common';
import mongoose from 'mongoose';
import { CustomerSchema, type ICustomer } from '../../customers/schemas/customer.schema';
import { EventSessionSchema, type IEventSession } from '../../event-sessions/schemas/event-session.schema';
import { EventSchema, type IEvent } from '../../events/schemas/event.schema';
import { MockOrderSchema, type IMockOrder } from '../../mock-orders/schemas/mock-order.schema';
import { ReviewSchema, type IReview } from '../../reviews/schemas/review.schema';
import { TicketSchema, type ITicket } from '../../tickets/schemas/ticket.schema';
import { EVENT_MESSENGER_ERROR } from '../constants/event-messengers.constants';
import {
  EventMessengerDeliverySchema,
  type IEventMessengerDelivery,
} from './event-messenger-delivery.schema';
import {
  EventMessengerIntegrationSchema,
  type IEventMessengerIntegration,
} from './event-messenger-integration.schema';

/*
 * Model getters in the universal `mongoose.models.X ?? mongoose.model(...)` form. The
 * event-messengers module is a leaf: Events, MockOrders, Reviews and Admin import it to
 * call its hooks, so it reads their documents through these instead of their services.
 */

export function eventMessengerIntegrationModel(): mongoose.Model<IEventMessengerIntegration> {
  return (
    (mongoose.models.EventMessengerIntegration as mongoose.Model<IEventMessengerIntegration>) ??
    mongoose.model<IEventMessengerIntegration>('EventMessengerIntegration', EventMessengerIntegrationSchema)
  );
}

export function eventMessengerDeliveryModel(): mongoose.Model<IEventMessengerDelivery> {
  return (
    (mongoose.models.EventMessengerDelivery as mongoose.Model<IEventMessengerDelivery>) ??
    mongoose.model<IEventMessengerDelivery>('EventMessengerDelivery', EventMessengerDeliverySchema)
  );
}

export function messengerEventModel(): mongoose.Model<IEvent> {
  return (mongoose.models.Event as mongoose.Model<IEvent>) ?? mongoose.model<IEvent>('Event', EventSchema);
}

export function messengerMockOrderModel(): mongoose.Model<IMockOrder> {
  return (
    (mongoose.models.MockOrder as mongoose.Model<IMockOrder>) ??
    mongoose.model<IMockOrder>('MockOrder', MockOrderSchema)
  );
}

export function messengerCustomerModel(): mongoose.Model<ICustomer> {
  return (
    (mongoose.models.Customer as mongoose.Model<ICustomer>) ??
    mongoose.model<ICustomer>('Customer', CustomerSchema)
  );
}

export function messengerTicketModel(): mongoose.Model<ITicket> {
  return (mongoose.models.Ticket as mongoose.Model<ITicket>) ?? mongoose.model<ITicket>('Ticket', TicketSchema);
}

export function messengerEventSessionModel(): mongoose.Model<IEventSession> {
  return (
    (mongoose.models.EventSession as mongoose.Model<IEventSession>) ??
    mongoose.model<IEventSession>('EventSession', EventSessionSchema)
  );
}

export function messengerReviewModel(): mongoose.Model<IReview> {
  return (mongoose.models.Review as mongoose.Model<IReview>) ?? mongoose.model<IReview>('Review', ReviewSchema);
}

/**
 * The event a messenger route addresses, or 404 `event_not_found`. Every admin messenger
 * entry point starts here, so an id that is not an event never reaches a write.
 */
export async function assertMessengerEvent(eventId: number): Promise<Pick<IEvent, 'id' | 'title'>> {
  const event = (await messengerEventModel()
    .findOne({ id: eventId })
    .select({ id: 1, title: 1 })
    .lean()
    .exec()) as Pick<IEvent, 'id' | 'title'> | null;
  if (!event) throw new NotFoundException(EVENT_MESSENGER_ERROR.EVENT_NOT_FOUND);
  return event;
}

let indexesReady: Promise<void> | null = null;

/**
 * Builds the unique indexes the exactly-once claims rely on before the first write.
 * Memoised; a failed build is retried on the next call.
 */
export function ensureEventMessengerIndexes(): Promise<void> {
  if (!indexesReady) {
    indexesReady = Promise.all([
      eventMessengerIntegrationModel().init(),
      eventMessengerDeliveryModel().init(),
    ]).then(
      () => undefined,
      (error) => {
        indexesReady = null;
        throw error;
      },
    );
  }
  return indexesReady;
}

/** Plain (lean) integration document. */
export type LeanEventMessengerIntegration = Omit<IEventMessengerIntegration, keyof mongoose.Document> & {
  _id: mongoose.Types.ObjectId;
};

/** Plain (lean) delivery document. */
export type LeanEventMessengerDelivery = Omit<IEventMessengerDelivery, keyof mongoose.Document> & {
  _id: mongoose.Types.ObjectId;
  /** `Document` declares its own `id`, so the autoinc number is re-added here. */
  id: number;
};

/** Mongo duplicate-key error (E11000). */
export function isDuplicateKeyError(error: unknown): boolean {
  return (error as { code?: number } | null)?.code === 11000;
}
