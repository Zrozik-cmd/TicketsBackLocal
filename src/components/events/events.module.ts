import { Module, forwardRef } from "@nestjs/common";
import { EventsController } from "./events.controller";
import { EventsPrivateController } from "./events-private.controller";
import { EventsPublicController } from "./events-public.controller";
import { EventsService } from "./events.service";
import { EventApprovalSnapshotsService } from "./event-approval-snapshots.service";
import { EventSponsorsService } from "./event-sponsors.service";
import { EventRemovalService } from "./event-removal.service";
import { EventStatusScheduler } from "./event-status.scheduler";
import { ManagersModule } from "../managers/managers.module";
import { MediaModule } from "../media/media.module";
import { UsersModule } from "../users/users.module";
import { SupportMessagesModule } from "../support-messages/support-messages.module";
import { EventSessionsModule } from "../event-sessions/event-sessions.module";
import { ReviewsModule } from "../reviews/reviews.module";
import { EventMessengersModule } from "../event-messengers/event-messengers.module";
import { IndexNowService } from "../../services/indexnow/indexnow.service";

@Module({
  imports: [
    forwardRef(() => ManagersModule),
    MediaModule,
    UsersModule,
    SupportMessagesModule,
    EventSessionsModule,
    ReviewsModule,
    EventMessengersModule,
  ],
  controllers: [
    EventsPublicController,
    EventsPrivateController,
    EventsController,
  ],
  providers: [
    EventsService,
    EventRemovalService,
    EventStatusScheduler,
    IndexNowService,
    EventApprovalSnapshotsService,
    EventSponsorsService,
  ],
  exports: [EventsService, IndexNowService, EventApprovalSnapshotsService, EventSponsorsService],
})
export class EventsModule {}
