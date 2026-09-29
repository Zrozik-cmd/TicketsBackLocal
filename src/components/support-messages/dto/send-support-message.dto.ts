import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class SendSupportMessageDto {
  @IsEmail()
  email: string;

  @IsString()
  @MaxLength(200)
  department: string;

  @IsString()
  @MaxLength(500)
  subject: string;

  @IsString()
  @MaxLength(100)
  priority: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  orderId?: string;

  @Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return false;
    return value === true || value === 'true' || value === 'on';
  })
  @IsBoolean()
  isOrderMissing: boolean;

  @IsString()
  @MaxLength(20000)
  message: string;
}
