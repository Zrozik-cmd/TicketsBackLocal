import { IsIn, IsOptional } from 'class-validator';
import { PAYOUT_STATUSES, PayoutStatus } from '../types/finance.types';

/** `?status=pending` — без параметра все выплаты (до 500 последних). */
export class FinancePayoutsQueryDto {
  @IsOptional()
  @IsIn(PAYOUT_STATUSES, { message: 'finance_invalid_filter' })
  status?: PayoutStatus;
}
