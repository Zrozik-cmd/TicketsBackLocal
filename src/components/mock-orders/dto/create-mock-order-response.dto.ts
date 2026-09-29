import { CreateOrderPaymentPayload } from '../payment/payment-microservice.types';
import type { PaymentCurrency } from './create-mock-order.dto';

/**
 * Response for POST /mock-orders: order + payment data for frontend
 */
export interface CreateMockOrderResponseDto {
  /** Created order (id, event, customer, price, total_price, status, tickets, etc.) */
  order: {
    id: number;
    event: number;
    customer: number;
    paymentCurrency: PaymentCurrency;
    price: number;
    total_price: number;
    vat?: number;
    additionalTicketCostFee?: number;
    /** Legacy Lotus card surcharge: always 0 for new orders (ARBI Pay charges its fee on its page). */
    bankCardFee?: number;
    /** Sum charged to the customer in `paymentCurrency`. */
    originalPaidAmount?: number;
    status: string;
    tickets: Array<{
      sectorId: string;
      zoneId: string;
      price: number;
      currency: string;
      count: number;
    }>;
    /** Present when a promo was applied: discount amount off subtotal before VAT. */
    promocodeDiscount?: number;
    createdAt: string;
    updatedAt: string;
  };
  /** Payment data to show pay button / QR / redirect; null if payment service is not configured */
  payment: CreateOrderPaymentPayload | null;
}
