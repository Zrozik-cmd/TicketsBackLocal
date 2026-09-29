import { IsString, MinLength, MaxLength } from 'class-validator';

export class UpdateCustomerDto {
  @IsString()
  @MinLength(1, { message: 'fullname must not be empty' })
  @MaxLength(200)
  fullname: string;
}
