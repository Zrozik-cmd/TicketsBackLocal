/**
 * Справочники конструктора схемы зала.
 *
 * Значения намертво связаны с SVG-графикой фронта (иконки объектов, арт площадок),
 * поэтому живут в коде, а не в коллекции: CRUD над ними сломал бы рендер.
 * Отдаются ручкой `GET /seating-plan/dictionaries`.
 */

export enum SeatingPlanStatus {
  /** Создан в конструкторе, не сохранён и не опубликован: виден только владельцу через /get. */
  DRAFT = 'DRAFT',
  /** Нажат «Save the Project» — попадает в My Templates. */
  TEMPLATE = 'TEMPLATE',
  /** Снапшот, привязанный к событию; места материализованы. */
  PUBLISHED = 'PUBLISHED',
  /** Заменён новой версией или снят с события; хранится ради проданных билетов. */
  ARCHIVED = 'ARCHIVED',
}

export enum NodeKind {
  SECTOR = 'sector',
  VENUE = 'venue',
  OBJECT = 'object',
}

export enum SectorType {
  SEATING = 'seating',
  STANDING = 'standing',
}

/**
 * Формы узлов. У сектора свой набор (rectangle, square, trapezoid, circle, semicircle,
 * corner), у площадки — свой (rectangle, trapezoid, circle, semicircle, arc).
 */
export enum NodeForm {
  RECTANGLE = 'rectangle',
  SQUARE = 'square',
  CIRCLE = 'circle',
  SEMICIRCLE = 'semicircle',
  TRAPEZOID = 'trapezoid',
  CORNER = 'corner',
  ARC = 'arc',
}

export enum VenueType {
  SCENE = 'scene',
  PLAYGROUND = 'playground',
  MOVIE_SCREEN = 'movie_screen',
  THEATER_STAGE = 'theater_stage',
  DANCE_FLOOR = 'dance_floor',
  ESPORTS_STAGE = 'esports_stage',
  CONFERENCE_STAGE = 'conference_stage',
  EXHIBITION_AREA = 'exhibition_area',
  BANQUET_AREA = 'banquet_area',
  EMPTY_COURT = 'empty_court',
}

export enum PlaygroundType {
  FOOTBALL_FIELD = 'football_field',
  BASKETBALL_COURT = 'basketball_court',
  HOCKEY_ARENA = 'hockey_arena',
  TENNIS_COURT = 'tennis_court',
  BOXING_RING = 'boxing_ring',
  MMA_OCTAGON = 'mma_octagon',
}

export enum ObjectType {
  ADD_TABLE = 'add_table',
  /** Банкетный стол на N мест с номером: вместимость — `capacity`. */
  NUMBERED_TABLE = 'numbered_table',
  ADD_CHAIR = 'add_chair',
  ADD_SOFA = 'add_sofa',
  ADD_BAR = 'add_bar',
  WARDROBE = 'wardrobe',
  ENTRANCE = 'entrance',
  TOILET = 'toilet',
  DISABLED_SEATS = 'disabled_seats',
  FIRST_AID = 'first_aid',
  PHOTO_ZONE = 'photo_zone',
  CLEAN_SECTOR = 'clean_sector',
}

/**
 * Объекты, дающие места: попав внутрь сектора, они увеличивают его вместимость
 * (номерной стол и диван — на свою `capacity`, остальные — на одно место).
 * Бар, гардероб, вход, туалет, медпункт, фотозона и чистый сектор мест не дают.
 */
export const SELLABLE_OBJECTS: string[] = [
  ObjectType.ADD_TABLE,
  ObjectType.NUMBERED_TABLE,
  ObjectType.ADD_CHAIR,
  ObjectType.ADD_SOFA,
  ObjectType.DISABLED_SEATS,
];

/** Объекты на несколько мест: число мест — их `capacity` (не меньше одного). */
export const MULTI_PLACE_OBJECTS: string[] = [ObjectType.NUMBERED_TABLE, ObjectType.ADD_SOFA];

export enum SeatType {
  CHAIR = 'chair',
  ARMCHAIR = 'armchair',
  SOFA = 'sofa',
}

export enum TicketCategory {
  ECONOMY = 'economy_class',
  BUSINESS = 'business_class',
  VIP = 'vip_class',
}

export enum Availability {
  AVAILABLE = 'available',
  UNAVAILABLE = 'unavailable',
}

export enum RowDirection {
  TOP_DOWN = 'top_down',
  BOTTOM_UP = 'bottom_up',
}

export enum SeatDirection {
  LEFT_TO_RIGHT = 'left_to_right',
  RIGHT_TO_LEFT = 'right_to_left',
}

export enum SeatSaleStatus {
  FREE = 'FREE',
  HELD = 'HELD',
  SOLD = 'SOLD',
  BLOCKED = 'BLOCKED',
}

/** Восемь фиксированных цветов из макета конструктора. */
export const SECTOR_COLORS = [
  { id: 'blue', hex: '#00ACC1' },
  { id: 'orange', hex: '#F59A0B' },
  { id: 'red', hex: '#E2413A' },
  { id: 'yellow', hex: '#F5CE28' },
  { id: 'green', hex: '#41A64A' },
  { id: 'violet', hex: '#8B2FBE' },
  { id: 'pink', hex: '#DD1B60' },
  { id: 'brown', hex: '#6B4A3F' },
] as const;

export const SECTOR_COLOR_IDS: string[] = SECTOR_COLORS.map((item) => item.id);

export const DEFAULT_ROOM_TITLE = 'The main hall';

/** Валюта Lotus Arena: тарифы события продаются в батах. */
export const DEFAULT_PLAN_CURRENCY = 'THB';

/**
 * Префикс id секторов и зон события, порождённых опубликованной схемой. По нему
 * перепубликация и снятие публикации отличают свои тарифы от заведённых руками
 * в карточке события — ручные остаются нетронутыми.
 */
export const PLAN_SECTOR_ID_PREFIX = 'plan-';

/** Коды ошибок, которые фронт конструктора переводит человеку. */
export const SEATING_PLAN_ERRORS = {
  planNotFound: 'plan_not_found',
  planIsPublished: 'plan_is_published',
  planIsArchived: 'plan_is_archived',
  planIsNotPublished: 'plan_is_not_published',
  planHasSoldTickets: 'plan_has_sold_tickets',
  planHasNoSectors: 'plan_has_no_sectors',
  planHasNoSellableSeats: 'plan_has_no_sellable_seats',
  /** Места в продаже с ценой 0; в ответе ещё `places` — где цены не хватает. */
  zeroPriceSeats: 'zero_price_seats',
  eventNotFound: 'event_not_found',
  eventArchived: 'event_archived',
  titleRequired: 'title_required',
  roomNotFound: 'room_not_found',
  lastRoom: 'last_room',
  nodeNotFound: 'node_not_found',
  rowNotFound: 'row_not_found',
  parentNotFound: 'parent_not_found',
  notASector: 'not_a_sector',
  unknownColor: 'unknown_color',
  playgroundTypeRequiresPlayground: 'playground_type_requires_playground',
  formNotAllowedForPlayground: 'form_not_allowed_for_playground',
  seatIndexOutOfRange: 'seat_index_out_of_range',
  emptyPatch: 'empty_patch',
  invalidImage: 'invalid_image',
  duplicateRowLabel: 'duplicate_row_label',
} as const;

const values = (source: object): string[] => Object.values(source);

/** Ответ `GET /seating-plan/dictionaries`: фронт не держит свою копию справочников. */
export const SEATING_PLAN_DICTIONARIES = {
  status: values(SeatingPlanStatus),
  nodeKind: values(NodeKind),
  sectorType: values(SectorType),
  form: values(NodeForm),
  venueType: values(VenueType),
  playgroundType: values(PlaygroundType),
  objectType: values(ObjectType),
  sellableObjects: SELLABLE_OBJECTS,
  seatType: values(SeatType),
  ticketCategory: values(TicketCategory),
  availability: values(Availability),
  rowDirection: values(RowDirection),
  seatDirection: values(SeatDirection),
  colors: SECTOR_COLORS,
  currency: DEFAULT_PLAN_CURRENCY,
};
