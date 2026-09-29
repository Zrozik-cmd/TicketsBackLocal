import { Global, Module, OnModuleInit } from '@nestjs/common';
import { NotificationService } from './notification.service';

@Global()
@Module({
  providers: [NotificationService],
  exports: [NotificationService],
})
export class NotificationModule implements OnModuleInit {
  constructor(private readonly notification: NotificationService) {}

  onModuleInit(): void {
    this.notification.logNotificationStatus();
  }
}
