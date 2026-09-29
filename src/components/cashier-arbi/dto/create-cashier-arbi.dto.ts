import { IsEmail, IsString, MinLength } from 'class-validator';

export class CreateCashierArbiDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(6)
  password: string;

  @IsString()
  @MinLength(1)
  pos_location: string;
}
