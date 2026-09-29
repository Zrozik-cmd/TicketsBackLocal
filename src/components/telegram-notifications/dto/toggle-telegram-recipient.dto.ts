import { IsBoolean } from 'class-validator';

export class ToggleTelegramRecipientDto {
  @IsBoolean()
  notificationsEnabled!: boolean;
}
