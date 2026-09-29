import { IsString, IsEmail, Length } from 'class-validator';

export class SignInWithCodeDto {
  @IsEmail()
  email: string;

  @IsString()
  @Length(6, 6, { message: 'code must be exactly 6 characters' })
  code: string;
}
