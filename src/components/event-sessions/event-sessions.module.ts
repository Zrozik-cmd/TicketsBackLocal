import { Module } from '@nestjs/common';
import { EventSessionsService } from './event-sessions.service';
import { SessionCancellationNotifier } from './session-cancellation-notifier.service';

@Module({
  providers: [EventSessionsService, SessionCancellationNotifier],
  exports: [EventSessionsService, SessionCancellationNotifier],
})
export class EventSessionsModule {}
