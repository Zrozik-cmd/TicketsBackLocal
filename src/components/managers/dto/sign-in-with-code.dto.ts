import { Type } from 'class-transformer';
import { IsEmail, IsInt, IsString, Length } from 'class-validator';

export class ManagerSignInWithCodeDto {
  @IsEmail()
  email: string;

  @Type(() => Number)
  @IsInt()
  event: number;

  @IsString()
  @Length(6, 6, { message: 'code must be exactly 6 characters' })
  code: string;
}
