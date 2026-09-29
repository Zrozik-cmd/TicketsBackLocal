/** UTC+7 — Lotus Arena Phuket */
export const TELEGRAM_SALES_NOTIFICATION_TIMEZONE = 'Asia/Bangkok';

export const TELEGRAM_USER_STATUSES = ['connected', 'pending', 'disabled'] as const;
export type TelegramUserStatus = (typeof TELEGRAM_USER_STATUSES)[number];

export const TELEGRAM_NOTIFICATION_LOG_STATUSES = ['sent', 'failed'] as const;
export type TelegramNotificationLogStatus = (typeof TELEGRAM_NOTIFICATION_LOG_STATUSES)[number];

export const TELEGRAM_RECIPIENT_ERROR = {
  INVALID_USERNAME: 'invalid_telegram_username',
  USERNAME_ALREADY_ADDED: 'telegram_username_already_added',
  RECIPIENT_NOT_FOUND: 'telegram_recipient_not_found',
} as const;

export const TELEGRAM_BOT_MESSAGES = {
  CONNECTED:
    'Вы подключены к уведомлениям о продажах Lotus Arena Phuket.',
  NOT_IN_LIST:
    'Ваш Telegram username не добавлен в список получателей. Обратитесь к администратору.',
  NO_USERNAME:
    'У вашего Telegram-аккаунта не указан username. Добавьте username в настройках Telegram и нажмите /start ещё раз.',
} as const;
