import { IsBoolean } from 'class-validator';

export class SetCashierActiveDto {
  @IsBoolean()
  active: boolean;
}
