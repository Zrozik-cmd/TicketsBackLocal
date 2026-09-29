import { IsNotEmpty, IsString } from 'class-validator';

export class CreateTelegramRecipientDto {
  @IsString()
  @IsNotEmpty()
  username!: string;
}
