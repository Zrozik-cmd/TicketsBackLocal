import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class UpdateCashierArbiDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MinLength(6)
  password?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  pos_location?: string;
}
