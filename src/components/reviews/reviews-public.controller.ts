import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { CustomerGuard, CUSTOMER_ID_KEY } from '../customers/guards/customer.guard';
import { CustomerAuthTokensHelper } from '../customers/customer-auth-tokens.helper';
import { CreateReviewDto } from './dto/create-review.dto';
import { ReviewsService } from './reviews.service';

@Controller()
export class ReviewsPublicController {
  constructor(
    private readonly reviewsService: ReviewsService,
    private readonly customerAuthTokens: CustomerAuthTokensHelper,
  ) {}

  /**
   * Public list. Reading is open, but a signed-in customer additionally sees their
   * own review while it waits for moderation — so the token is decoded when present
   * instead of being required by a guard.
   */
  /** Newest approved reviews of recurring events — the listing-page carousel. */
  @Get('reviews/public/latest')
  latest(@Query('limit') limitRaw?: string) {
    const limit = Number.parseInt(limitRaw ?? '', 10);
    return this.reviewsService.listLatestPublic(Number.isFinite(limit) ? limit : 12);
  }

  @Get('events/public/:eventId/reviews')
  list(@Req() req: Request, @Param('eventId', ParseIntPipe) eventId: number) {
    return this.reviewsService.listPublic(eventId, this.optionalCustomerId(req));
  }

  @UseGuards(CustomerGuard)
  @Post('reviews')
  create(@Req() req: Request, @Body() dto: CreateReviewDto) {
    const customerId = Number((req as any)[CUSTOMER_ID_KEY]);
    return this.reviewsService.create(dto, customerId);
  }

  private optionalCustomerId(req: Request): number | undefined {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return undefined;
    try {
      const { customerId } = this.customerAuthTokens.verifyAccessToken(header.slice(7));
      const parsed = Number(customerId);
      return Number.isFinite(parsed) ? parsed : undefined;
    } catch {
      // An expired or foreign token simply means "anonymous reader".
      return undefined;
    }
  }
}
