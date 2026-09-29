export class PromoOrderHistoryItemDto {
  orderId: number;
  customerId: number;
  customerName: string;
  eventId: number;
  eventName: string;
  /** ISO 8601 — order creation time. */
  date: string;
  ticketCount: number;
}

export class PromoOrdersHistoryResponseDto {
  items: PromoOrderHistoryItemDto[];
  total: number;
  page: number;
  limit: number;
}
