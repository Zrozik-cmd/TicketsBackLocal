import { IsInt, Min } from 'class-validator';

export class CancelMockOrderDto {
  @IsInt()
  @Min(1)
  orderId: number;
}
