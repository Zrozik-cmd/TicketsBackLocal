import { Module, forwardRef } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { UsersModule } from '../users/users.module';
import { ManagersAuthController } from './managers-auth.controller';
import { ManagerAuthTokensHelper } from './manager-auth-tokens.helper';
import { ManagersAuthService } from './managers-auth.service';
import { ManagersController } from './managers.controller';
import { ManagersService } from './managers.service';

@Module({
  imports: [forwardRef(() => EventsModule), forwardRef(() => UsersModule)],
  controllers: [ManagersController, ManagersAuthController],
  providers: [ManagersService, ManagersAuthService, ManagerAuthTokensHelper],
  exports: [ManagersService, ManagersAuthService, ManagerAuthTokensHelper],
})
export class ManagersModule {}
