import {
  IsEmail,
  IsString,
  IsOptional,
  IsBoolean,
  Length,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';

/** Registration: either idToken (Google) or fullname + email + emailCode (manual). */
export class RegisterCustomerDto {
  /** Google ID token — when present, register with name/email from Google. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  idToken?: string;

  @ValidateIf((o) => !o.idToken)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  fullname?: string;

  @ValidateIf((o) => !o.idToken)
  @IsEmail()
  email?: string;

  @ValidateIf((o) => !o.idToken)
  @IsString()
  @Length(6, 6, { message: 'emailCode must be exactly 6 characters' })
  emailCode?: string;

  /** Required when manual registration (no idToken). */
  @ValidateIf((o) => !o.idToken)
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  termsAccepted?: boolean;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  referralCode?: string;
}
