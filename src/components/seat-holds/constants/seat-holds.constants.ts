/** Коды ошибок закрепления мест схемы за заказом — их переводит фронт. */
export const SEAT_HOLD_ERRORS = {
  /** У события нет опубликованной схемы, а в заказе пришли места. */
  seatsNotAvailable: "seats_not_available",
  /** Места схемы продаются только у разового события (у сеансов своя занятость). */
  seatsForSessions: "seats_not_for_sessions",
  /** Число мест строки не совпадает с количеством билетов. */
  seatsCountMismatch: "seats_count_mismatch",
  /** Место не из этой зоны, не из схемы события или снято с продажи. */
  seatNotInZone: "seat_not_in_zone",
  /** Одно место дважды в заказе. */
  seatDuplicated: "seat_duplicated",
  /** Место уже держит другой заказ; в ответе `seatIds` — какие. */
  seatTaken: "seat_taken",
} as const;

/** Не больше мест в одной строке заказа, чем разумно купить разом. */
export const MAX_SEATS_PER_LINE = 50;
