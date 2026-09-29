import type { IMockOrder, IMockOrderRefund } from '../schemas/mock-order.schema';

export type MockOrderRefundFeeRates = {
  processingFeeRate: number;
};

export type MockOrderRefundCalculation = {
  originalPaidAmount: number;
  originalCurrency: string;
  grossAmountTHB: number;
  processingFeeTHB: number;
  platformFeeTHB: number;
  vatTHB: number;
  additionalFeeTHB: number;
  /** Bank-card surcharge withheld from the refund alongside processing fee and VAT. */
  bankCardFeeTHB: number;
  /** Cash-payment fee (platform income) withheld from the refund, same as the bank-card surcharge. */
  cashFeeTHB: number;
  totalCommissionTHB: number;
  exchangeRate: number;
  commissionInOriginalCurrency: number;
  refundAmount: number;
};

export function roundMoney(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function resolvePaymentMethodLabel(currency: string, method?: string): string {
  if (method === 'QR') return 'PromptPay QR (Omise)';
  if (method === 'ALIPAY') return 'Alipay (Omise)';
  if (method === 'CARD') return 'Card (Omise)';
  switch (currency) {
    case 'RUB':
      return 'SBP (RUB)';
    case 'KZT':
      return 'Card (KZT)';
    case 'USDT':
      return 'Crypto (USDT)';
    case 'THB':
      // No Omise method on a THB order means the legacy manual flow (old bank account).
      return 'QR THB (OLD)';
    default:
      return currency;
  }
}

export function buildRefundCalculation(
  order: Pick<
    IMockOrder,
    | 'price'
    | 'total_price'
    | 'vat'
    | 'additionalTicketCostFee'
    | 'bankCardFee'
    | 'cashFee'
    | 'paymentCurrency'
    | 'originalPaidAmount'
  >,
  feeRates: MockOrderRefundFeeRates,
): MockOrderRefundCalculation {
  const grossAmountTHB = Number(order.total_price) || 0;
  const processingFeeTHB = Math.abs(Number(order.price) || 0) * feeRates.processingFeeRate;
  const vatTHB = Math.abs(Number(order.vat) || 0);
  const additionalFeeTHB = Math.abs(Number(order.additionalTicketCostFee) || 0);
  const bankCardFeeTHB = Math.abs(Number(order.bankCardFee) || 0);
  const cashFeeTHB = Math.abs(Number(order.cashFee) || 0);
  const totalCommissionTHB = roundMoney(processingFeeTHB + vatTHB + bankCardFeeTHB + cashFeeTHB);

  const originalCurrency = order.paymentCurrency;
  const originalPaidAmount =
    order.originalPaidAmount != null
      ? Number(order.originalPaidAmount)
      : originalCurrency === 'THB'
        ? grossAmountTHB
        : 0;

  const exchangeRate =
    originalPaidAmount > 0 ? roundMoney(grossAmountTHB / originalPaidAmount, 4) : 0;
  const priceWithoutCommission = roundMoney(
    grossAmountTHB - processingFeeTHB - vatTHB - bankCardFeeTHB - cashFeeTHB,
  );
  const refundAmount =
    exchangeRate > 0 ? roundMoney(priceWithoutCommission / exchangeRate) : 0;
  const commissionInOriginalCurrency = roundMoney(originalPaidAmount - refundAmount);

  return {
    originalPaidAmount: roundMoney(originalPaidAmount),
    originalCurrency,
    grossAmountTHB: roundMoney(grossAmountTHB),
    processingFeeTHB: roundMoney(processingFeeTHB),
    platformFeeTHB: 0,
    vatTHB: roundMoney(vatTHB),
    additionalFeeTHB: roundMoney(additionalFeeTHB),
    bankCardFeeTHB: roundMoney(bankCardFeeTHB),
    cashFeeTHB: roundMoney(cashFeeTHB),
    totalCommissionTHB,
    exchangeRate,
    commissionInOriginalCurrency,
    refundAmount,
  };
}

export function refundSnapshotToCalculation(refund: IMockOrderRefund): MockOrderRefundCalculation {
  return {
    originalPaidAmount: refund.originalPaidAmount,
    originalCurrency: refund.originalCurrency,
    grossAmountTHB: refund.grossAmountTHB,
    processingFeeTHB: refund.processingFeeTHB,
    platformFeeTHB: refund.platformFeeTHB,
    vatTHB: refund.vatTHB,
    additionalFeeTHB: refund.additionalFeeTHB,
    bankCardFeeTHB: refund.bankCardFeeTHB ?? 0,
    cashFeeTHB: refund.cashFeeTHB ?? 0,
    totalCommissionTHB: refund.totalCommissionTHB,
    exchangeRate: refund.exchangeRate,
    commissionInOriginalCurrency: refund.commissionInOriginalCurrency,
    refundAmount: refund.refundAmount,
  };
}

export function buildRefundSnapshotFromCalculation(
  calculation: MockOrderRefundCalculation,
  params: {
    status: IMockOrderRefund['status'];
    createdAt: Date;
    createdBy: string;
    completedAt?: Date;
    completedBy?: string;
    cancelledAt?: Date;
    cancelledBy?: string;
    comment?: string;
  },
): IMockOrderRefund {
  return {
    ...calculation,
    status: params.status,
    createdAt: params.createdAt,
    createdBy: params.createdBy,
    completedAt: params.completedAt,
    completedBy: params.completedBy,
    cancelledAt: params.cancelledAt,
    cancelledBy: params.cancelledBy,
    comment: params.comment,
  };
}

export function buildRefundSupportMessage(
  orderId: number,
  calc: MockOrderRefundCalculation,
): string {
  const { originalCurrency } = calc;
  const priceWithoutCommission = roundMoney(
    calc.grossAmountTHB - calc.processingFeeTHB - calc.vatTHB - calc.bankCardFeeTHB - calc.cashFeeTHB,
  );
  return [
    `По заказу #${orderId} необходимо согласовать возврат с клиентом.`,
    '',
    `Клиент оплатил: ${calc.originalPaidAmount} ${originalCurrency}.`,
    `Сумма заказа в системе: ${calc.grossAmountTHB} THB.`,
    '',
    'Возврат осуществляется за вычетом комиссии сервиса.',
    '',
    'Комиссия:',
    `- processing fee: ${calc.processingFeeTHB} THB`,
    `- VAT: ${calc.vatTHB} THB`,
    ...(calc.bankCardFeeTHB > 0
      ? [`- комиссия оплаты банковской картой: ${calc.bankCardFeeTHB} THB`]
      : []),
    ...(calc.cashFeeTHB > 0
      ? [`- комиссия за оплату наличными: ${calc.cashFeeTHB} THB`]
      : []),
    '',
    `Итого комиссия: ${calc.totalCommissionTHB} THB.`,
    `Сумма без комиссии: ${priceWithoutCommission} THB.`,
    '',
    'Расчётный курс:',
    `${calc.grossAmountTHB} THB / ${calc.originalPaidAmount} ${originalCurrency} = ${calc.exchangeRate} THB за 1 ${originalCurrency}.`,
    '',
    'Сумма к возврату клиенту:',
    `${priceWithoutCommission} THB / ${calc.exchangeRate} = ${calc.refundAmount} ${originalCurrency}.`,
    '',
    'Пожалуйста, согласуйте с клиентом возврат на указанную сумму.',
    'Если клиент подтверждает возврат — передайте информацию бухгалтерии для ручного возврата средств.',
    'Если клиент не согласен с удержанием комиссии и хочет оставить билет — сообщите, чтобы заказ был возвращён в активный статус.',
  ].join('\n');
}
