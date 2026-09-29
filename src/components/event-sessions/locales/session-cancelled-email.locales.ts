export type SessionCancelledEmailLocale = 'en' | 'ru' | 'th';

type SessionCancelledEmailDictionary = {
  /** Placeholders: `{title}`, `{date}`. */
  subject: string;
  title: string;
  /** Placeholders: `{title}`, `{date}`. */
  body: string;
  footer: string;
  /** Locale tag the dates are written in (`th-TH` gives the Buddhist-era year Thai readers expect). */
  dateLocale: string;
  fields: {
    orderNumber: string;
    event: string;
    cancelledTickets: string;
    date: string;
    time: string;
    sector: string;
    zone: string;
    quantity: string;
  };
};

/**
 * Letter to a buyer whose show was cancelled by the organizer (force majeure).
 * Sent once per paid order, in the order's locale (English when unknown).
 */
export const SESSION_CANCELLED_EMAIL_LOCALES: Record<
  SessionCancelledEmailLocale,
  SessionCancelledEmailDictionary
> = {
  en: {
    subject: 'Event cancelled: {title} — {date}',
    title: 'Event cancelled',
    body:
      'The event “{title}” on {date} has been cancelled. Your tickets for this date are no longer valid. We will contact you about rescheduling or a refund.',
    footer: 'Lotus Arena',
    dateLocale: 'en-GB',
    fields: {
      orderNumber: 'Order number',
      event: 'Event',
      cancelledTickets: 'Cancelled tickets',
      date: 'Date',
      time: 'Time',
      sector: 'Sector',
      zone: 'Zone',
      quantity: 'Qty',
    },
  },
  ru: {
    subject: 'Отмена мероприятия: {title} — {date}',
    title: 'Мероприятие отменено',
    body:
      'Мероприятие «{title}» {date} отменено. Ваши билеты на эту дату аннулированы. Мы свяжемся с вами по поводу переноса или возврата средств.',
    footer: 'Lotus Arena',
    dateLocale: 'ru-RU',
    fields: {
      orderNumber: 'Номер заказа',
      event: 'Мероприятие',
      cancelledTickets: 'Аннулированные билеты',
      date: 'Дата',
      time: 'Время',
      sector: 'Сектор',
      zone: 'Зона',
      quantity: 'Кол-во',
    },
  },
  th: {
    subject: 'ยกเลิกอีเวนต์: {title} — {date}',
    title: 'อีเวนต์ถูกยกเลิก',
    body:
      'อีเวนต์ “{title}” วันที่ {date} ถูกยกเลิกแล้ว ตั๋วของคุณสำหรับวันดังกล่าวไม่สามารถใช้งานได้อีกต่อไป เราจะติดต่อคุณเกี่ยวกับการเลื่อนวันจัดงานหรือการคืนเงิน',
    footer: 'Lotus Arena',
    dateLocale: 'th-TH',
    fields: {
      orderNumber: 'หมายเลขคำสั่งซื้อ',
      event: 'อีเวนต์',
      cancelledTickets: 'ตั๋วที่ถูกยกเลิก',
      date: 'วันที่',
      time: 'เวลา',
      sector: 'เซกเตอร์',
      zone: 'โซน',
      quantity: 'จำนวน',
    },
  },
};
