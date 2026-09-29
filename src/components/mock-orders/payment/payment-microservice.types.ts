/**
 * Request body for POST {PAYMENT_SERVICE_URL}/transactions
 */
export interface CreateTransactionRequest {
  type: 'payment';
  amount: number;
  currency?: string;
  outputCurrency?: string;
  provider: 'arbi' | 'stripe';
  externalId?: string;
  metadata?: {
    orderId?: string;
    description?: string;
    paymentMethod?: number;
    /**
     * Код точки (store) ARBIPAY этого события. Микросервис берёт его из metadata и
     * передаёт в ARBIPAY как `store_code`; без него платёж идёт в общую точку клиента.
     */
    storeCode?: string;
    [key: string]: unknown;
  };
  redirectPath?: string;
}

/**
 * Transaction response from payment microservice (201)
 */
export interface PaymentTransactionResponse {
  _id: string;
  clientId: string;
  type: string;
  amount: number;
  currency: string;
  outputCurrency?: string;
  outputAmount?: number;
  status: 'processing' | 'failed' | string;
  provider: string;
  providerTransactionId?: string;
  metadata?: {
    orderId?: string;
    paymentMethod?: number;
    paymentUrl?: string | null;
    cryptoWallet?: string | null;
    qrLink?: string | null;
    arbiPayload?: Record<string, unknown>;
    [key: string]: unknown;
  };
  redirectUrl?: string;
  externalId?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Data returned to frontend after creating order + transaction
 */
export interface CreateOrderPaymentPayload {
  orderId: number;
  paymentUrl: string | null;
  cryptoWallet: string | null;
  qrLink: string | null;
  redirectUrl: string | null;
  status: string;
  providerTransactionId?: string | null;
  /** Сумма в минимальных единицах валюты списания (как в микросервисе) */
  amount: number | null;
  /** Валюта списания (RUB, USDT, KZT и т.д.) */
  currency: string | null;
  outputAmount?: number | null;
  outputCurrency?: string | null;
  /**
   * Полный metadata ответа микросервиса (USDT-сумма в другом формате, arbiPayload и т.д.).
   * Фронт может взять сумму к оплате в USDT отсюда, если она не в amount/currency.
   */
  providerMetadata: Record<string, unknown> | null;
}
