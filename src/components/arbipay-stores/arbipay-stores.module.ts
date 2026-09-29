import { Module } from '@nestjs/common';
import { ArbiPayStoresService } from './arbipay-stores.service';

/**
 * Точки (stores) ARBIPAY событий: своя точка на каждое событие, прошедшее модерацию.
 * Самостоятельный модуль со своей коллекцией `eventarbipaystores`; создание идёт
 * через платёжный микросервис, поэтому ключей ARBIPAY здесь нет.
 * Выключено без ARBIPAY_STORES_ENABLED=true (на dev/prod — GitHub variable).
 */
@Module({
  providers: [ArbiPayStoresService],
  exports: [ArbiPayStoresService],
})
export class ArbiPayStoresModule {}
