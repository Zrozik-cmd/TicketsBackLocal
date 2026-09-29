import { IsEmail, IsOptional, IsString, Length, MaxLength, MinLength } from 'class-validator';

export class CheckoutAuthWithEmailDto {
  @IsEmail()
  email: string;

  @IsString()
  @Length(6, 6, { message: 'code must be exactly 6 characters' })
  code: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  fullname?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  referralCode?: string;
}
