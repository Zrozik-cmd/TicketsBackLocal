import { Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ReferralLinksService } from './referral-links.service';

@Controller('referral-links/public')
export class ReferralLinksPublicController {
  constructor(private readonly referralLinksService: ReferralLinksService) {}

  @Post('follow-referral-link/:referralCode')
  @HttpCode(HttpStatus.NO_CONTENT)
  async follow(@Param('referralCode') referralCode: string): Promise<void> {
    await this.referralLinksService.followByReferralCode(referralCode);
  }
}
