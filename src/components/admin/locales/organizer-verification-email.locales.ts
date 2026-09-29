export type OrganizerVerificationEmailLocale = 'en' | 'ru' | 'th';

type VerificationEmailCopy = {
  subject: string;
  /** Обращение; {{name}} подставляется, если известно название компании. */
  greetingNamed: string;
  greetingPlain: string;
  body: string[];
  /** Только для отказа: подпись перед причиной. */
  reasonLabel?: string;
  signature: string;
};

type OrganizerVerificationEmailDictionary = {
  approved: VerificationEmailCopy;
  rejected: VerificationEmailCopy;
};

/**
 * Письма о результате проверки организатора.
 *
 * Язык берётся из профиля: организатор регистрировался на одном из трёх
 * языков сайта, и письмо о его же аккаунте должно прийти на нём. Для
 * аккаунтов без сохранённой локали остаётся английский — так же, как в
 * письмах по бронированиям (см. cash-booking-email.locales.ts).
 */
export const ORGANIZER_VERIFICATION_EMAIL_LOCALES: Record<
  OrganizerVerificationEmailLocale,
  OrganizerVerificationEmailDictionary
> = {
  ru: {
    approved: {
      subject: 'Lotus Arena: аккаунт организатора подтверждён',
      greetingNamed: '{{name}}, здравствуйте!',
      greetingPlain: 'Здравствуйте!',
      body: [
        'Проверка документов пройдена — ваш аккаунт организатора подтверждён.',
        'Теперь события, которые вы отправляете на модерацию, рассматриваются как от проверенного организатора.',
      ],
      signature: 'Lotus Arena',
    },
    rejected: {
      subject: 'Lotus Arena: заявка отклонена',
      greetingNamed: '{{name}}, здравствуйте!',
      greetingPlain: 'Здравствуйте!',
      body: [
        'К сожалению, мы не смогли подтвердить ваш аккаунт организатора.',
        'Исправьте замечание и напишите нам — мы проверим заявку повторно.',
      ],
      reasonLabel: 'Причина',
      signature: 'Lotus Arena',
    },
  },
  en: {
    approved: {
      subject: 'Lotus Arena: organizer account verified',
      greetingNamed: 'Hello, {{name}}!',
      greetingPlain: 'Hello!',
      body: [
        'Your documents have been checked — your organizer account is verified.',
        'Events you submit for moderation are now reviewed as coming from a verified organizer.',
      ],
      signature: 'Lotus Arena',
    },
    rejected: {
      subject: 'Lotus Arena: your request was rejected',
      greetingNamed: 'Hello, {{name}}!',
      greetingPlain: 'Hello!',
      body: [
        'Unfortunately, we could not verify your organizer account.',
        'Please fix the issue and contact us — we will review your request again.',
      ],
      reasonLabel: 'Reason',
      signature: 'Lotus Arena',
    },
  },
  th: {
    approved: {
      subject: 'Lotus Arena: บัญชีผู้จัดงานได้รับการยืนยันแล้ว',
      greetingNamed: 'สวัสดีคุณ {{name}}',
      greetingPlain: 'สวัสดีค่ะ/ครับ',
      body: [
        'ตรวจสอบเอกสารเรียบร้อยแล้ว — บัญชีผู้จัดงานของคุณได้รับการยืนยัน',
        'ตั้งแต่นี้ อีเวนต์ที่คุณส่งเข้าตรวจสอบจะถือว่ามาจากผู้จัดงานที่ได้รับการยืนยันแล้ว',
      ],
      signature: 'Lotus Arena',
    },
    rejected: {
      subject: 'Lotus Arena: คำขอของคุณถูกปฏิเสธ',
      greetingNamed: 'สวัสดีคุณ {{name}}',
      greetingPlain: 'สวัสดีค่ะ/ครับ',
      body: [
        'ขออภัย เราไม่สามารถยืนยันบัญชีผู้จัดงานของคุณได้',
        'กรุณาแก้ไขตามข้อสังเกตและติดต่อเรา เราจะตรวจสอบคำขออีกครั้ง',
      ],
      reasonLabel: 'เหตุผล',
      signature: 'Lotus Arena',
    },
  },
};

export function resolveVerificationEmailLocale(
  raw?: string,
): OrganizerVerificationEmailLocale {
  if (raw === 'ru' || raw === 'th' || raw === 'en') {
    return raw;
  }
  return 'en';
}
