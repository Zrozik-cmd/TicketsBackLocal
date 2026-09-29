import type { ILocalizedText } from '../../events/schemas/event.schema';

export interface EventTicketSalesZoneInfo {
  id: string;
  name: ILocalizedText;
  price: number;
  allTicketsCount: number;
  soldTicketsCount: number;
  remainingTicketsCount: number;
}

export interface EventTicketSalesSectorInfo {
  id: string;
  name: ILocalizedText;
  priceRange: { min: number; max: number };
  allTicketsCount: number;
  soldTicketsCount: number;
  remainingTicketsCount: number;
  zonesInfo: EventTicketSalesZoneInfo[];
}

export interface EventTicketSalesStatistics {
  sectorsCount: number;
  soldTicketsCount: number;
  remainingTicketsCount: number;
  avgTicketPrice: number;
  sectorsInfo: EventTicketSalesSectorInfo[];
}
