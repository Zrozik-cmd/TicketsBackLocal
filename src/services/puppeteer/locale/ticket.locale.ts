export type TicketEmailLocale = 'en' | 'ru' | 'th';

type TicketEmailDictionary = {
  subject: string;
  title: string;
  subtitle: string;
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
    /** Место схемы зала на билете. */
    seat: string;
  };
  actions: {
    openTicket: string;
  };
  /** Labels and copy for `template.html` (Puppeteer ticket PDF). */
  ticketPdf: {
    dateTitle: string;
    timeTitle: string;
    startTitle: string;
    arrivalNote: string;
    sellerTitle: string;
    serviceTitle: string;
    orderTitle: string;
    infoAndDetailsTitle: string;
    /** Channel name shown next to the service icon (e.g. Online). */
    serviceChannel: string;
    ticketRulesTitle: string;
    /** Use \\n between lines; template uses pre-line for wrapping. */
    ticketRulesDescription: string;
    dontShareOnSocialMediaTitle: string;
    /**
     * Title of the "Sponsored by" block (event sponsors), by the number of sponsors printed:
     * `one` for a single sponsor, `many` for 2-3.
     */
    sponsorsTitle: { one: string; many: string };
  };
};

export const TICKET_EMAIL_LOCALES: Record<TicketEmailLocale, TicketEmailDictionary> = {
  en: {
    subject: 'Your tickets are ready',
    title: 'Payment confirmed',
    subtitle: 'Your tickets are attached as PDF files. Have a great event!',
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
      seat: 'Seat',
    },
    actions: {
      openTicket: 'Open ticket',
    },
    ticketPdf: {
      dateTitle: 'Date',
      timeTitle: 'Time',
      startTitle: 'Start',
      arrivalNote: 'Please arrive at least 30 minutes before start.',
      sellerTitle: 'Seller',
      serviceTitle: 'Service',
      orderTitle: 'Order number',
      infoAndDetailsTitle: 'Information and details',
      serviceChannel: 'Online',
      ticketRulesTitle: 'Ticket presentation rules',
      ticketRulesDescription:
        'You may enter only once with this ticket.\nPresent your ticket at the entrance.',
      dontShareOnSocialMediaTitle: 'Do not post your ticket on social media!',
      sponsorsTitle: { one: 'Sponsored by', many: 'Sponsored by' },
    },
  },
  ru: {
    subject: 'Ваши билеты готовы',
    title: 'Оплата подтверждена',
    subtitle: 'Ваши билеты во вложении в формате PDF. Приятного мероприятия!',
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
      seat: 'Место',
    },
    actions: {
      openTicket: 'Открыть билет',
    },
    ticketPdf: {
      dateTitle: 'Дата',
      timeTitle: 'Время',
      startTitle: 'Начало',
      arrivalNote:
        'Рекомендуем прибыть заранее - это поможет избежать очередей и занять своё место без спешки',
      sellerTitle: 'Продавец',
      serviceTitle: 'Сервис',
      orderTitle: 'Номер заказа',
      infoAndDetailsTitle: 'Информация и детали',
      serviceChannel: 'Онлайн',
      ticketRulesTitle: 'Правила предъявления билета',
      ticketRulesDescription:
        'По билету можно пройти только один раз.\nПредъявите билет на входе.',
      dontShareOnSocialMediaTitle:
        'Не выкладывайте билет в соцсети: другой человек может использовать QR-код и пройти вместо вас!',
      sponsorsTitle: { one: 'Спонсор', many: 'Спонсоры' },
    },
  },
  th: {
    subject: 'ตั๋วของคุณพร้อมแล้ว',
    title: 'ยืนยันการชำระเงินแล้ว',
    subtitle: 'แนบตั๋วของคุณในรูปแบบ PDF แล้ว ขอให้สนุกกับงาน!',
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
      seat: 'ที่นั่ง',
    },
    actions: {
      openTicket: 'เปิดตั๋ว',
    },
    ticketPdf: {
      dateTitle: 'วันที่',
      timeTitle: 'เวลา',
      startTitle: 'เริ่ม',
      arrivalNote: 'กรุณามาถึงก่อนเวลาเริ่มอย่างน้อย 30 นาที',
      sellerTitle: 'ผู้ขาย',
      serviceTitle: 'บริการ',
      orderTitle: 'หมายเลขคำสั่งซื้อ',
      infoAndDetailsTitle: 'ข้อมูลและรายละเอียด',
      serviceChannel: 'ออนไลน์',
      ticketRulesTitle: 'กฎการใช้ตั๋ว',
      ticketRulesDescription:
        'ใช้ตั๋วนี้เข้าได้เพียงครั้งเดียว\nกรุณาแสดงตั๋วที่ทางเข้า',
      dontShareOnSocialMediaTitle: 'อย่าโพสต์ตั๋วลงโซเชียลมีเดีย!',
      sponsorsTitle: { one: 'ผู้สนับสนุน', many: 'ผู้สนับสนุน' },
    },
  },
};
