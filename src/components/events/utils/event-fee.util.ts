import type { IEvent } from '../schemas/event.schema';
import type { IUser } from '../../users/schemas/user.schema';
import {
  DEFAULT_VAT_PERCENT,
  DEFAULT_PROCESSING_FEE_PERCENT,
  DEFAULT_PLATFORM_FEE_PERCENT,
  DEFAULT_ADDITIONAL_TICKET_COST_FEE_PERCENT,
  DEFAULT_CASH_FEE_PERCENT,
} from '../constants/event-fee-defaults.constant';

export type EventFeePercents = {
  vatPercent: number;
  additionalTicketCostFeePercent: number;
  processingFeePercent: number;
  platformFeePercent: number;
  /** Service commission on cash payments; charged on top of the VAT-inclusive total. */
  cashFeePercent: number;
};

export type UserDefaultFeePercents = {
  defaultVatPercent: number;
  defaultProcessingFeePercent: number;
  defaultPlatformFeePercent: number;
  defaultAdditionalTicketCostFeePercent: number;
};

export function resolveUserDefaultFeePercents(
  user: Partial<
    Pick<
      IUser,
      | 'defaultVatPercent'
      | 'defaultProcessingFeePercent'
      | 'defaultPlatformFeePercent'
      | 'defaultAdditionalTicketCostFeePercent'
    >
  >,
): UserDefaultFeePercents {
  return {
    defaultVatPercent: user.defaultVatPercent ?? DEFAULT_VAT_PERCENT,
    defaultProcessingFeePercent:
      user.defaultProcessingFeePercent ?? DEFAULT_PROCESSING_FEE_PERCENT,
    defaultPlatformFeePercent: user.defaultPlatformFeePercent ?? DEFAULT_PLATFORM_FEE_PERCENT,
    defaultAdditionalTicketCostFeePercent:
      user.defaultAdditionalTicketCostFeePercent ?? DEFAULT_ADDITIONAL_TICKET_COST_FEE_PERCENT,
  };
}

export function resolveEventFeePercents(
  event: Partial<
    Pick<
      IEvent,
      | 'vatPercent'
      | 'additionalTicketCostFeePercent'
      | 'processingFeePercent'
      | 'platformFeePercent'
      | 'cashFeePercent'
    >
  >,
): EventFeePercents {
  return {
    vatPercent: event.vatPercent ?? DEFAULT_VAT_PERCENT,
    additionalTicketCostFeePercent:
      event.additionalTicketCostFeePercent ?? DEFAULT_ADDITIONAL_TICKET_COST_FEE_PERCENT,
    processingFeePercent: event.processingFeePercent ?? DEFAULT_PROCESSING_FEE_PERCENT,
    platformFeePercent: event.platformFeePercent ?? DEFAULT_PLATFORM_FEE_PERCENT,
    cashFeePercent: event.cashFeePercent ?? DEFAULT_CASH_FEE_PERCENT,
  };
}

/** Decimal multipliers (e.g. 7% → 0.07) for pricing math. */
export function eventFeeRatesFromPercents(percents: EventFeePercents): {
  vatRate: number;
  additionalTicketCostFeeRate: number;
  processingFeeRate: number;
  platformFeeRate: number;
  cashFeeRate: number;
} {
  return {
    vatRate: percents.vatPercent / 100,
    additionalTicketCostFeeRate: percents.additionalTicketCostFeePercent / 100,
    processingFeeRate: percents.processingFeePercent / 100,
    platformFeeRate: percents.platformFeePercent / 100,
    cashFeeRate: percents.cashFeePercent / 100,
  };
}
