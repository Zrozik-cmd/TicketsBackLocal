import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ReferralLinksService } from './referral-links.service';
import { ReferralPayoutsQueryDto } from './dto/referral-payouts-query.dto';
import { VerifyReferralCabinetDto } from './dto/verify-referral-cabinet.dto';
import {
  REFERRAL_CABINET_SESSION_LINK_ID_KEY,
  ReferralPinCodeGuard,
} from './guards/referral-pin-code.guard';
import {
  REFERRAL_CABINET_SESSION_COOKIE,
  REFERRAL_CABINET_SESSION_COOKIE_MAX_AGE_MS,
} from './constants/referral-cabinet-session.constants';
import { ReferralCabinetSessionResponseDto } from './dto/referral-cabinet-session-response.dto';

const IS_PROD = process.env.NODE_ENV === 'production'

const REFERRAL_CABINET_COOKIE_OPTIONS = {
  httpOnly: true,
  maxAge: REFERRAL_CABINET_SESSION_COOKIE_MAX_AGE_MS,
  path: '/referral-links/cabinet',
  sameSite: IS_PROD ? ('none' as const) : ('lax' as const),
  secure: IS_PROD,
};

@Controller('referral-links/cabinet')
export class ReferralLinksCabinetController {
  constructor(private readonly referralLinksService: ReferralLinksService) {}

  @Post('session')
  async openSession(
    @Body() dto: VerifyReferralCabinetDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReferralCabinetSessionResponseDto> {
    const { sessionToken, expiresInSeconds } =
      await this.referralLinksService.verifyCabinetAndOpenSession(dto);
    res.cookie(REFERRAL_CABINET_SESSION_COOKIE, sessionToken, REFERRAL_CABINET_COOKIE_OPTIONS);
    const out = new ReferralCabinetSessionResponseDto();
    out.expiresInSeconds = expiresInSeconds;
    return out;
  }

  @Get('follows-by-day')
  @UseGuards(ReferralPinCodeGuard)
  getFollowsByDay(
    @Req() req: Request,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const linkId = (req as any)[REFERRAL_CABINET_SESSION_LINK_ID_KEY] as string;
    return this.referralLinksService.getFollowsByDayForCabinet(linkId, from, to);
  }

  @Get('cabinet-payouts')
  @UseGuards(ReferralPinCodeGuard)
  getPayouts(@Req() req: Request, @Query() query: ReferralPayoutsQueryDto) {
    const linkId = (req as any)[REFERRAL_CABINET_SESSION_LINK_ID_KEY] as string;
    return this.referralLinksService.getReferralPayoutsForCabinet(
      linkId,
      query.page,
      query.limit,
    );
  }

  @Get('statistics')
  @UseGuards(ReferralPinCodeGuard)
  getInfo(@Req() req: Request) {
    const linkId = (req as any)[REFERRAL_CABINET_SESSION_LINK_ID_KEY] as string;
    return this.referralLinksService.findOneForCabinet(linkId);
  }
}
