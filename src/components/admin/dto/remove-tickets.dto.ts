import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsISO8601,
  IsString,
  MaxLength,
  Min,
} from "class-validator";

/** Билеты одного заказа за раз; сервер сам проверяет, что заказ один. */
export const TICKET_REMOVAL_MAX_TICKETS = 50;

/** `POST /admin/vault/tickets/removal-preview`. */
export class TicketRemovalPreviewDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(TICKET_REMOVAL_MAX_TICKETS)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  ticketIds!: number[];
}

/** `POST /admin/vault/tickets/remove`. */
export class RemoveTicketsDto extends TicketRemovalPreviewDto {
  /** Фраза из превью, набранная вручную; сервер пересчитывает её сам. */
  @IsString()
  @MaxLength(120)
  confirmation!: string;

  /** `order.updatedAt` из превью: заказ, изменённый после него, не трогаем (409). */
  @IsISO8601()
  expectedOrderUpdatedAt!: string;
}
