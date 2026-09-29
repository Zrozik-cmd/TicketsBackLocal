import {
  IsString,
  IsEmail,
  Length,
  Matches,
  MaxLength,
  MinLength,
  IsOptional,
} from 'class-validator';

export class SignInWithCodeDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MinLength(10)
  @MaxLength(25)
  @Matches(/^[+]?[0-9\s()-]+$/, { message: 'phoneNumber must contain only digits and optional + - ( )' })
  phoneNumber?: string;

  @IsString()
  @Length(6, 6, { message: 'code must be exactly 6 characters' })
  code: string;
}
