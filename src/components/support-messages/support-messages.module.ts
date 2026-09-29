import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { SupportMessagesController } from './support-messages.controller';
import { SupportMessagesService } from './support-messages.service';

@Module({
  imports: [
    HttpModule.register({
      timeout: 120_000,
      maxRedirects: 0,
    }),
  ],
  controllers: [SupportMessagesController],
  providers: [SupportMessagesService],
  exports: [SupportMessagesService],
})
export class SupportMessagesModule {}
