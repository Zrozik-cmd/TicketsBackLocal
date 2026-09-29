import type {
  IMockOrderRefund,
  MockOrderPaymentCurrency,
  MockOrderStatus,
  RefundStatus,
} from '../schemas/mock-order.schema';
import type { MockOrderRefundCalculation } from '../utils/mock-order-refund.util';

export interface MockOrderRefundDetailsResponse {
  orderId: number;
  buyerName: string;
  ticketCount: number;
  eventId: number;
  eventTitle: string;
  purchasedAt: string;
  orderStatus: MockOrderStatus;
  paymentMethod: string;
  paymentCurrency: MockOrderPaymentCurrency;
  originalPaidAmount: number | null;
  grossAmountTHB: number;
  totalCommissionTHB: number;
  refundAmount: number;
  refundStatus: RefundStatus;
  refundCreatedAt: string | null;
  refundCompletedAt: string | null;
  refundStatusChangedByEmail: string | null;
  calculation: MockOrderRefundCalculation;
  supportMessage: string;
  refund: IMockOrderRefund | null;
}

export interface MockOrderRefundActionResponse {
  success: true;
  orderStatus: MockOrderStatus;
  refundStatus: RefundStatus;
  refundStatusChangedByEmail?: string;
  refund: IMockOrderRefund | null;
}
