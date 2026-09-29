import { IsBoolean, IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class SendEmailCodeDto {
  @IsEmail()
  email: string;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  forSignIn?: boolean;
}

export class SendPhoneCodeDto {
  @IsString()
  @MinLength(10)
  @MaxLength(25)
  @Matches(/^[+]?[0-9\s()-]+$/, { message: 'phone must contain only digits and optional + - ( )' })
  phone: string;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  forSignIn?: boolean;
}
