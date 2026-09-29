import { Module, forwardRef } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { ManagersModule } from '../managers/managers.module';
import { MediaModule } from '../media/media.module';
import { UsersModule } from '../users/users.module';
import { SeatingPlanController, SeatingPlanPublicController } from './controllers/seating-plan.controller';
import { SeatingPlanService } from './services/seating-plan.service';
import { SeatingPlanNodesService } from './services/seating-plan-nodes.service';
import { SeatingPlanRowsService } from './services/seating-plan-rows.service';
import { SeatingPlanTotalsService } from './services/seating-plan-totals.service';
import { SeatingPlanPublishService } from './services/seating-plan-publish.service';
import { SeatingPlanMapService } from './services/seating-plan-map.service';

/**
 * Конструктор схемы зала (перенос из Tentai): проекты, холсты, секторы, ряды, места
 * и объекты, шаблоны организатора и публикация схемы в тарифы события.
 * EventsService нужен публикации — тарифы пишутся штатным update события.
 */
@Module({
  imports: [forwardRef(() => EventsModule), forwardRef(() => ManagersModule), UsersModule, MediaModule],
  controllers: [SeatingPlanPublicController, SeatingPlanController],
  providers: [
    SeatingPlanService,
    SeatingPlanNodesService,
    SeatingPlanRowsService,
    SeatingPlanTotalsService,
    SeatingPlanPublishService,
    SeatingPlanMapService,
  ],
  exports: [SeatingPlanService, SeatingPlanPublishService],
})
export class SeatingPlanModule {}
