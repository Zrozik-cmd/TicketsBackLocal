import {
  IsBoolean,
  IsNumber,
  IsArray,
  ValidateNested,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MockOrderTicketDto } from './mock-order-ticket.dto';
import {
  PAYMENT_CURRENCIES,
  type PaymentCurrency,
} from '../constants/payment-currency.constant';
import {
  ARBIPAY_THB_ERRORS,
  ARBIPAY_THB_METHODS,
  type ArbipayThbMethod,
} from '../constants/arbipay-thb.constant';

export { PAYMENT_CURRENCIES, type PaymentCurrency };

export class CreateMockOrderDto {
  @IsNumber()
  event: number;

  /**
   * Legacy field (ignored by backend business logic).
   * Customer id is always taken from access token via CustomerGuard.
   */
  @IsOptional()
  @IsNumber()
  customer?: number;

  /**
   * Валюта/способ оплаты: RUB (СБП), USDT (крипто), KZT (карты), THB (manual check).
   * По умолчанию RUB.
   */
  @IsOptional()
  @IsIn(PAYMENT_CURRENCIES, {
    message: 'paymentCurrency must be RUB, USDT, KZT or THB',
  })
  paymentCurrency?: PaymentCurrency;

  /**
   * THB only: `card` or `promptpay`, both paid on ARBI Pay's page (the wire name stays for
   * older clients). Anything else, e.g. the removed `alipay` → 400 `payment_method_unavailable`.
   * Omitted for THB → the legacy manual receipt flow.
   */
  @IsOptional()
  @IsIn(ARBIPAY_THB_METHODS, {
    message: ARBIPAY_THB_ERRORS.METHOD_UNAVAILABLE,
  })
  omisePaymentMethod?: ArbipayThbMethod;

  /** Legacy Omise card token: still accepted from older clients and ignored (ARBI Pay takes the card). */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  omiseToken?: string;

  @IsOptional()
  @IsIn(['en', 'ru', 'th'], {
    message: 'locale must be en, ru or th',
  })
  locale?: 'en' | 'ru' | 'th';

  /** If set, validated against event and customer limits; order subtotal is discounted before VAT. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  promoCode?: string;

  /** Optional email-marketing consent checkbox; forwarded to Mailchimp only after payment succeeds. */
  @IsOptional()
  @IsBoolean()
  newsletterOptIn?: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MockOrderTicketDto)
  tickets: MockOrderTicketDto[];
}
