import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { NewsletterController } from './newsletter.controller';
import { NewsletterService } from './services/newsletter.service';
import { MailchimpService } from './services/mailchimp.service';

@Module({
  imports: [HttpModule.register({ timeout: 15000, maxRedirects: 0 })],
  controllers: [NewsletterController],
  providers: [NewsletterService, MailchimpService],
  exports: [MailchimpService],
})
export class NewsletterModule {}
