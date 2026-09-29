import { IsEmail } from 'class-validator';

export class SendManagerEmailCodeDto {
  @IsEmail()
  email: string;
}
