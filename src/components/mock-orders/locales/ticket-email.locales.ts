export type TicketEmailLocale = 'en' | 'ru' | 'th';

/**
 * Language of the tickets attached to a buyer's letter (the letter itself keeps the order's
 * locale): tickets are printed in Russian or English only, so a Thai order gets English
 * tickets (customer decision 2026-09-18).
 */
export function attachedTicketLocale(letterLocale: TicketEmailLocale): TicketEmailLocale {
  return letterLocale === 'ru' ? 'ru' : 'en';
}

type TicketEmailDictionary = {
  subject: string;
  title: string;
  /** Subtitle when the tickets are attached as WebP images (`event.ticketFormat` 'webp' or absent). */
  subtitle: string;
  /** Subtitle when the tickets are attached as PDF files (`event.ticketFormat` 'pdf'). */
  subtitlePdf: string;
  footer: string;
  fields: {
    event: string;
    purchaseDate: string;
    eventDate: string;
    sector: string;
    zone: string;
    price: string;
    buyer: string;
    email: string;
    ticketCode: string;
    ticketId: string;
  };
  actions: {
    openTicket: string;
  };
};

export const TICKET_EMAIL_LOCALES: Record<TicketEmailLocale, TicketEmailDictionary> = {
  en: {
    subject: 'Your tickets are ready',
    title: 'Payment confirmed',
    subtitle: 'Your tickets are attached as WebP images (one per ticket). Have a great event!',
    subtitlePdf: 'Your tickets are attached as PDF files (one per ticket). Have a great event!',
    footer: 'Lotus Arena',
    fields: {
      event: 'Event',
      purchaseDate: 'Purchase date',
      eventDate: 'Event date',
      sector: 'Sector',
      zone: 'Zone',
      price: 'Price',
      buyer: 'Buyer',
      email: 'Email',
      ticketCode: 'Ticket code',
      ticketId: 'Ticket ID',
    },
    actions: {
      openTicket: 'Open ticket',
    },
  },
  ru: {
    subject: 'Ваши билеты готовы',
    title: 'Оплата подтверждена',
    subtitle: 'Ваши билеты во вложении (WebP, по одному на билет). Приятного мероприятия!',
    subtitlePdf: 'Ваши билеты во вложении (PDF, по одному на билет). Приятного мероприятия!',
    footer: 'Lotus Arena',
    fields: {
      event: 'Событие',
      purchaseDate: 'Дата покупки',
      eventDate: 'Дата ивента',
      sector: 'Сектор',
      zone: 'Зона',
      price: 'Цена',
      buyer: 'Покупатель',
      email: 'Email',
      ticketCode: 'Код билета',
      ticketId: 'ID билета',
    },
    actions: {
      openTicket: 'Открыть билет',
    },
  },
  th: {
    subject: 'ตั๋วของคุณพร้อมแล้ว',
    title: 'ยืนยันการชำระเงินแล้ว',
    subtitle: 'แนบรูปตั๋ว (WebP) ต่อหนึ่งใบแล้ว ขอให้สนุกกับงาน!',
    subtitlePdf: 'แนบไฟล์ตั๋ว (PDF) ต่อหนึ่งใบแล้ว ขอให้สนุกกับงาน!',
    footer: 'Lotus Arena',
    fields: {
      event: 'อีเวนต์',
      purchaseDate: 'วันที่ซื้อ',
      eventDate: 'วันที่อีเวนต์',
      sector: 'เซกเตอร์',
      zone: 'โซน',
      price: 'ราคา',
      buyer: 'ผู้ซื้อ',
      email: 'อีเมล',
      ticketCode: 'รหัสตั๋ว',
      ticketId: 'รหัสตั๋ว',
    },
    actions: {
      openTicket: 'เปิดตั๋ว',
    },
  },
};
