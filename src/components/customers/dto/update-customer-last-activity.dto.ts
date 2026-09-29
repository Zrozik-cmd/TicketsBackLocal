import { Type } from 'class-transformer';
import { IsDate } from 'class-validator';

export class UpdateCustomerLastActivityDto {
  @Type(() => Date)
  @IsDate()
  lastActivity: Date;
}
