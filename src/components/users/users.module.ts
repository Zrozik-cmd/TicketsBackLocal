import { MediaModule } from '../media/media.module';
import { Module, forwardRef } from '@nestjs/common';
import { ManagersModule } from '../managers/managers.module';
import { UsersController } from './users.controller';
import { AuthController } from './auth.controller';
import { UsersService } from './users.service';
import { AuthService } from './auth.service';
import { UserGuard } from './guards/user.guard';
import { UserAuthTokensHelper } from './user-auth-tokens.helper';

@Module({
  imports: [forwardRef(() => ManagersModule), MediaModule],
  controllers: [UsersController, AuthController],
  providers: [UsersService, AuthService, UserAuthTokensHelper, UserGuard],
  exports: [UsersService, AuthService, UserAuthTokensHelper, UserGuard],
})
export class UsersModule {}
