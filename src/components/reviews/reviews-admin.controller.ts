import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard, ADMIN_ID_KEY } from '../admin/guards/admin.guard';
import { RejectReviewDto, UpdateReviewDto } from './dto/create-review.dto';
import { UpdateReviewSettingsDto } from './dto/update-review-settings.dto';
import { ReviewsService } from './reviews.service';

/** Moderation queue and per-event review settings, both admin-only. */
@Controller('admin')
@UseGuards(AdminGuard)
export class ReviewsAdminController {
  constructor(private readonly reviewsService: ReviewsService) {}

  /** Events that have reviews, with per-event moderation counters. */
  @Get('reviews/events')
  listEvents() {
    return this.reviewsService.listEventsWithReviewStats();
  }

  @Get('reviews')
  list(@Query('status') status?: string, @Query('eventId') eventId?: string) {
    const parsedEventId = eventId ? Number(eventId) : undefined;
    return this.reviewsService.listForModeration(status, parsedEventId);
  }

  @Patch('reviews/:id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateReviewDto) {
    return this.reviewsService.updateReview(id, dto);
  }

  @Delete('reviews/:id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.reviewsService.deleteReview(id);
  }

  @Post('reviews/:id/approve')
  approve(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.reviewsService.setStatus(id, 'approved', this.moderator(req));
  }

  @Post('reviews/:id/reject')
  reject(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RejectReviewDto,
  ) {
    return this.reviewsService.setStatus(id, 'rejected', this.moderator(req), dto?.reason);
  }

  @Patch('events/:id/review-settings')
  updateSettings(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateReviewSettingsDto,
  ) {
    return this.reviewsService.updateEventReviewSettings(id, dto);
  }

  private moderator(req: any): string {
    return `admin:${req?.[ADMIN_ID_KEY] ?? 'unknown'}`;
  }
}
