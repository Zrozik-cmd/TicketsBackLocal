/**
 * Aggregated sales figures for paid mock orders (single bucket).
 */
export interface MockOrderSalesStatsBucket {
  sum_total_price: number;
  sum_price: number;
  sum_processing_fee: number;
  sum_platform_fee: number;
  sum_vat_fee: number;
  sum_additional_ticket_cost_fee: number;
  /** Bank-card surcharge collected from buyers (card payments only). */
  sum_bank_card_fee: number;
  /** Service commission collected from buyers who paid cash. */
  sum_cash_fee: number;
  sum_net_payout: number;
}

/**
 * GET /mock-orders/sales/events/:eventId/statistics
 */
export interface MockOrderEventSalesStatistics {
  general: {
    all: MockOrderSalesStatsBucket;
  };
  byPaymentMethod: {
    sbp_rub_kzt: MockOrderSalesStatsBucket;
    /** Legacy THB flow (manual transfer + receipt upload) — paid to the OLD bank account. */
    qr_thb_old: MockOrderSalesStatsBucket;
    /** Omise PromptPay QR — paid to the Omise account. */
    qr_thb_omise: MockOrderSalesStatsBucket;
    /** Omise card payments (THB). */
    card_omise: MockOrderSalesStatsBucket;
    /** Omise Alipay (THB). Collected already; UI display stays hidden until verification. */
    alipay_omise: MockOrderSalesStatsBucket;
    crypto_usdt: MockOrderSalesStatsBucket;
    cash: MockOrderSalesStatsBucket;
  };
}
