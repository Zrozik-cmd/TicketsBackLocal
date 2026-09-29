import type { TelegramUserStatus } from '../constants/telegram.constants';

export type TelegramRecipientResponseDto = {
  id: number;
  telegramUserId: number;
  usernameFromAdmin: string;
  realTelegramUserId: string | null;
  realTelegramUsername: string | null;
  chatId: string | null;
  status: TelegramUserStatus;
  notificationsEnabled: boolean;
  startedAt: string | null;
  createdAt: string;
};
