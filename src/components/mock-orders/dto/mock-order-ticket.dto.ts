import { ArrayMaxSize, IsArray, IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { MAX_SEATS_PER_LINE } from '../../seat-holds/constants/seat-holds.constants';

export class MockOrderTicketDto {
  @IsString()
  sectorId: string;

  @IsString()
  zoneId: string;

  @IsNumber()
  @Min(1)
  count: number;

  /**
   * EventSession.id. Required for regular (recurring) events — each session sells its
   * own inventory. Lines of a single order may point at different sessions, so one
   * order can cover several show dates.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  session?: number;

  /**
   * Места схемы зала (SeatingPlanSeat.id), выбранные на схеме: ровно `count` штук. Заказ
   * их закрепляет за собой, билеты печатаются с местом. Без них — билеты зоны без места.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_SEATS_PER_LINE)
  @IsInt({ each: true })
  @Min(1, { each: true })
  seatIds?: number[];
}
