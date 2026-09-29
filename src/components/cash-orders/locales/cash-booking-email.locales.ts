export type CashBookingEmailLocale = 'en' | 'ru' | 'th';

type CashBookingStatusEmail = {
  subject: string;
  title: string;
  subtitle: string;
  footer: string;
  fields: {
    bookingNumber: string;
    event: string;
    tickets: string;
    amount: string;
    selectedPos: string;
    venue: string;
    validUntil: string;
    buyer: string;
  };
};

type CashBookingEmailDictionary = {
  booking: {
    subject: string;
    title: string;
    subtitle: string;
    footer: string;
    fields: {
      bookingNumber: string;
      event: string;
      tickets: string;
      amount: string;
      selectedPos: string;
      venue: string;
      validUntil: string;
      buyer: string;
    };
  };
  expired: CashBookingStatusEmail;
  cancelled: CashBookingStatusEmail;
};

export const CASH_BOOKING_EMAIL_LOCALES: Record<
  CashBookingEmailLocale,
  CashBookingEmailDictionary
> = {
  en: {
    booking: {
      subject: 'Your cash booking is reserved',
      title: 'Booking reserved',
      subtitle:
        'Please pay in cash at the selected POS before the booking expires. The booking is valid for 1 hour.',
      footer: 'Lotus Arena',
      fields: {
        bookingNumber: 'Booking number',
        event: 'Event',
        tickets: 'Tickets',
        amount: 'Amount',
        selectedPos: 'Selected POS',
        venue: 'Venue',
        validUntil: 'Valid until',
        buyer: 'Buyer',
      },
    },
    expired: {
      subject: 'Cash booking expired',
      title: 'Booking expired',
      subtitle: 'Your booking has expired.',
      footer: 'Lotus Arena',
      fields: {
        bookingNumber: 'Booking number',
        event: 'Event',
        tickets: 'Tickets',
        amount: 'Amount',
        selectedPos: 'Selected POS',
        venue: 'Venue',
        validUntil: 'Valid until',
        buyer: 'Buyer',
      },
    },
    cancelled: {
      subject: 'Cash booking cancelled',
      title: 'Booking cancelled',
      subtitle: 'Your ticket booking has been cancelled.',
      footer: 'Lotus Arena',
      fields: {
        bookingNumber: 'Booking number',
        event: 'Event',
        tickets: 'Tickets',
        amount: 'Amount',
        selectedPos: 'Selected POS',
        venue: 'Venue',
        validUntil: 'Valid until',
        buyer: 'Buyer',
      },
    },
  },
  ru: {
    booking: {
      subject: 'Ваше бронирование зарезервировано',
      title: 'Бронирование создано',
      subtitle:
        'Оплатите наличными в выбранной точке продаж до истечения срока. Бронирование действует 1 час.',
      footer: 'Lotus Arena',
      fields: {
        bookingNumber: 'Номер бронирования',
        event: 'Событие',
        tickets: 'Билеты',
        amount: 'Сумма',
        selectedPos: 'Точка оплаты',
        venue: 'Площадка',
        validUntil: 'Действительно до',
        buyer: 'Покупатель',
      },
    },
    expired: {
      subject: 'Бронирование истекло',
      title: 'Бронирование отменено',
      subtitle: 'Срок бронирования истёк.',
      footer: 'Lotus Arena',
      fields: {
        bookingNumber: 'Номер бронирования',
        event: 'Событие',
        tickets: 'Билеты',
        amount: 'Сумма',
        selectedPos: 'Точка оплаты',
        venue: 'Площадка',
        validUntil: 'Действительно до',
        buyer: 'Покупатель',
      },
    },
    cancelled: {
      subject: 'Бронирование отменено',
      title: 'Бронирование отменено',
      subtitle: 'Ваше бронирование билетов отменено.',
      footer: 'Lotus Arena',
      fields: {
        bookingNumber: 'Номер бронирования',
        event: 'Событие',
        tickets: 'Билеты',
        amount: 'Сумма',
        selectedPos: 'Точка оплаты',
        venue: 'Площадка',
        validUntil: 'Действительно до',
        buyer: 'Покупатель',
      },
    },
  },
  th: {
    booking: {
      subject: 'การจองเงินสดของคุณถูกสำรองแล้ว',
      title: 'จองสำเร็จ',
      subtitle:
        'กรุณาชำระเงินสดที่จุดชำระที่เลือกก่อนหมดเวลา การจองมีอายุ 1 ชั่วโมง',
      footer: 'Lotus Arena',
      fields: {
        bookingNumber: 'หมายเลขการจอง',
        event: 'อีเวนต์',
        tickets: 'ตั๋ว',
        amount: 'จำนวนเงิน',
        selectedPos: 'จุดชำระเงิน',
        venue: 'สถานที่',
        validUntil: 'ใช้ได้ถึง',
        buyer: 'ผู้จอง',
      },
    },
    expired: {
      subject: 'การจองเงินสดหมดอายุ',
      title: 'การจองหมดอายุ',
      subtitle: 'การจองหมดอายุแล้ว',
      footer: 'Lotus Arena',
      fields: {
        bookingNumber: 'หมายเลขการจอง',
        event: 'อีเวนต์',
        tickets: 'ตั๋ว',
        amount: 'จำนวนเงิน',
        selectedPos: 'จุดชำระเงิน',
        venue: 'สถานที่',
        validUntil: 'ใช้ได้ถึง',
        buyer: 'ผู้จอง',
      },
    },
    cancelled: {
      subject: 'การจองเงินสดถูกยกเลิก',
      title: 'การจองถูกยกเลิก',
      subtitle: 'การจองตั๋วของคุณถูกยกเลิกแล้ว',
      footer: 'Lotus Arena',
      fields: {
        bookingNumber: 'หมายเลขการจอง',
        event: 'อีเวนต์',
        tickets: 'ตั๋ว',
        amount: 'จำนวนเงิน',
        selectedPos: 'จุดชำระเงิน',
        venue: 'สถานที่',
        validUntil: 'ใช้ได้ถึง',
        buyer: 'ผู้จอง',
      },
    },
  },
};
