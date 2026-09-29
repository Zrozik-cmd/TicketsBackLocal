import { IsArray, IsIn, IsNumber, IsOptional, IsString, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CreateMockOrderDto } from '../../mock-orders/dto/create-mock-order.dto';
import { MockOrderTicketDto } from '../../mock-orders/dto/mock-order-ticket.dto';

export class BookCashOrderDto {
  @Type(() => Number)
  @IsNumber()
  event: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MockOrderTicketDto)
  tickets: MockOrderTicketDto[];

  @IsString()
  @MinLength(1)
  selected_pos: string;

  @IsOptional()
  @IsIn(['en', 'ru', 'th'], {
    message: 'locale must be en, ru or th',
  })
  locale?: 'en' | 'ru' | 'th';

  @IsOptional()
  @IsString()
  promoCode?: string;
}

export function toCreateMockOrderDto(dto: BookCashOrderDto): CreateMockOrderDto {
  return {
    event: dto.event,
    tickets: dto.tickets,
    locale: dto.locale,
    promoCode: dto.promoCode,
    paymentCurrency: 'THB',
  };
}
