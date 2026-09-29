import { IsBoolean, IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class SendEmailCodeDto {
  @IsEmail()
  email: string;

  /** При true — код отправляется только если пользователь с таким email уже зарегистрирован (вход). */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  forSignIn?: boolean;
}

export class SendPhoneCodeDto {
  @IsString()
  @MinLength(10)
  @MaxLength(25)
  @Matches(/^[+]?[0-9\s()-]+$/, { message: 'phoneNumber must contain only digits and optional + - ( )' })
  phoneNumber: string;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  forSignIn?: boolean;
}
