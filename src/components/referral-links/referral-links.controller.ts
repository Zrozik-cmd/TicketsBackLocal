import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { CreateReferralLinkDto } from './dto/create-referral-link.dto';
import { CreateReferralPayoutDto } from './dto/create-referral-payout.dto';
import { UpdateReferralLinkDto } from './dto/update-referral-link.dto';
import { ReferralLinksService } from './referral-links.service';
import { ReferralLinkCustomersQueryDto } from './dto/referral-link-customers-query.dto';
import { ReferralPayoutsQueryDto } from './dto/referral-payouts-query.dto';
import { USER_ID_KEY } from '../users/guards/user.guard';
import { UserOrManagerGuard } from '../users/guards/user-or-manager.guard';

@Controller('referral-links')
export class ReferralLinksController {
  constructor(private readonly referralLinksService: ReferralLinksService) {}

  @UseGuards(UserOrManagerGuard(['Admin', 'Marketing']))
  @Get()
  findAll(@Req() req: Request) {
    return this.referralLinksService.findAll((req as any)[USER_ID_KEY] as string);
  }

  @UseGuards(UserOrManagerGuard(['Admin', 'Marketing']))
  @Get(':id/stats/follows-by-day')
  findFollowsByDay(
    @Req() req: Request,
    @Param('id') id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.referralLinksService.getFollowsByDay(id, (req as any)[USER_ID_KEY] as string, from, to);
  }

  @UseGuards(UserOrManagerGuard(['Admin', 'Marketing']))
  @Get(':id/customers')
  getCustomers(
    @Req() req: Request,
    @Param('id') id: string,
    @Query() query: ReferralLinkCustomersQueryDto,
  ) {
    return this.referralLinksService.getCustomersForReferralLink(
      id,
      (req as any)[USER_ID_KEY] as string,
      query.page,
      query.limit,
    );
  }

  @UseGuards(UserOrManagerGuard(['Admin', 'Marketing']))
  @Get(':id/payouts')
  getPayouts(
    @Req() req: Request,
    @Param('id') id: string,
    @Query() query: ReferralPayoutsQueryDto,
  ) {
    return this.referralLinksService.getReferralPayoutsForOwner(
      id,
      (req as any)[USER_ID_KEY] as string,
      query.page,
      query.limit,
    );
  }

  @UseGuards(UserOrManagerGuard(['Admin', 'Marketing']))
  @Get(':id')
  findOne(@Req() req: Request, @Param('id') id: string) {
    return this.referralLinksService.findOne(id, (req as any)[USER_ID_KEY] as string);
  }

  @UseGuards(UserOrManagerGuard(['Admin']))
  @Delete(':id')
  remove(@Req() req: Request, @Param('id') id: string) {
    return this.referralLinksService.remove(id, (req as any)[USER_ID_KEY] as string);
  }

  @UseGuards(UserOrManagerGuard(['Admin']))
  @Patch(':id')
  update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateReferralLinkDto) {
    return this.referralLinksService.update(id, (req as any)[USER_ID_KEY] as string, dto);
  }

  @UseGuards(UserOrManagerGuard(['Admin']))
  @Post()
  create(@Req() req: Request, @Body() dto: CreateReferralLinkDto) {
    return this.referralLinksService.create(dto, (req as any)[USER_ID_KEY] as string);
  }

  @UseGuards(UserOrManagerGuard(['Admin', 'Marketing']))
  @Post(':id/payouts')
  recordPayout(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: CreateReferralPayoutDto,
  ) {
    return this.referralLinksService.recordReferralPayout(
      id,
      (req as any)[USER_ID_KEY] as string,
      dto.paidAmount,
    );
  }
}
