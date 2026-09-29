import { Module } from '@nestjs/common';
import { AdminGuard } from '../admin/guards/admin.guard';
import { AdminAuthTokensHelper } from '../admin/admin-auth-tokens.helper';
import { AdminHomeHeroController } from './controllers/admin-home-hero.controller';
import { HomeHeroService } from './home-hero.service';

/**
 * «Главное событие» первого экрана: выбор в админке и крон возврата к режиму по умолчанию.
 * Лист: никаких модулей не импортирует; публичный hero (EventsService) читает настройку
 * функцией из home-hero-links.ts. Гвард админки объявлен здесь же, как в CashEncashmentsModule.
 */
@Module({
  controllers: [AdminHomeHeroController],
  providers: [HomeHeroService, AdminGuard, AdminAuthTokensHelper],
})
export class HomeHeroModule {}
