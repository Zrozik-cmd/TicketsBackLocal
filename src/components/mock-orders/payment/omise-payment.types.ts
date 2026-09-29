export const OMISE_PAYMENT_METHODS = ['promptpay', 'alipay', 'card'] as const;

export type OmisePaymentMethod = (typeof OMISE_PAYMENT_METHODS)[number];

export interface OmiseChargeResponse {
  object: 'charge';
  id: string;
  amount: number;
  currency: string;
  status: 'failed' | 'expired' | 'pending' | 'reversed' | 'successful' | string;
  paid?: boolean;
  authorize_uri?: string | null;
  return_uri?: string | null;
  failure_code?: string | null;
  failure_message?: string | null;
  metadata?: Record<string, unknown> | null;
  card?: Record<string, unknown> | null;
  source?: {
    id?: string;
    type?: string;
    scannable_code?: {
      image?: {
        download_uri?: string | null;
        uri?: string | null;
      } | null;
      [key: string]: unknown;
    } | null;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

export interface OmiseEventPayload {
  object?: string;
  id?: string;
  key?: string;
  data?: OmiseChargeResponse;
  [key: string]: unknown;
}
