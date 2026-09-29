import { IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class UploadCheckDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  orderId: number;
}
