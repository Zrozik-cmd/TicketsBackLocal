import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'crypto';
import mongoose from 'mongoose';
import { RedisService } from '../../services/redis/redis.service';
import { CreateReferralLinkDto } from './dto/create-referral-link.dto';
import { UpdateReferralLinkDto } from './dto/update-referral-link.dto';
import {
  ReferralLinkDetailResponseDto,
  ReferralLinkStatsResponseDto,
} from './dto/referral-link-detail-response.dto';
import { ReferralLinkResponseDto } from './dto/referral-link-response.dto';
import {
  IReferralLink,
  ReferralLinkSchema,
} from './schemas/referral-link.schema';
import {
  IReferralLinkStats,
  ReferralLinkStatsSchema,
} from './schemas/referral-link-stats.schema';
import {
  IReferralLinkFollowDaily,
  ReferralLinkFollowDailySchema,
} from './schemas/referral-link-follow-daily.schema';
import {
  IReferralShare,
  ReferralShareSchema,
} from './schemas/referral-share.schema';
import {
  IReferralPayout,
  ReferralPayoutSchema,
} from './schemas/referral-payout.schema';
import { ReferralLinkFollowDayPointDto } from './dto/referral-link-follows-by-day.dto';
import {
  ReferralLinkCustomerDto,
  ReferralLinkCustomersPageDto,
} from './dto/referral-link-customer.dto';
import { VerifyReferralCabinetDto } from './dto/verify-referral-cabinet.dto';
import {
  ReferralPayoutResponseDto,
  ReferralPayoutsPageDto,
} from './dto/referral-payout-response.dto';
import {
  REFERRAL_CABINET_SESSION_TTL_SEC,
  referralCabinetSessionRedisKey,
} from './constants/referral-cabinet-session.constants';
import { ICustomer, CustomerSchema } from '../customers/schemas/customer.schema';
import { IMockOrder, MockOrderSchema } from '../mock-orders/schemas/mock-order.schema';
import { IEvent, EventSchema } from '../events/schemas/event.schema';

type LeanReferralLink = {
  _id: mongoose.Types.ObjectId;
  userId: number;
  internalName: string;
  source: string;
  referralCode: string;
  partnerCabinetPin: string;
  status: 'active' | 'inactive';
  hasReward: boolean;
  rewardPercent: number;
  createdAt: Date;
  updatedAt: Date;
};

type LeanReferralLinkStats = {
  follows: number;
  registrations: number;
  totalSalesCount: number;
  totalSalesAmount: number;
  totalSalesAmountWithVat: number;
  conversionRate: number;
  sharesTotalAmount: number;
  sharesPaidAmount: number;
  createdAt: Date;
  updatedAt: Date;
};

const FOLLOWS_BY_DAY_MAX_RANGE_DAYS = 366;

function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseUtcDayKey(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.trim())) {
    return null;
  }
  const d = new Date(`${s.trim()}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function addUtcDaysToKey(dayKey: string, deltaDays: number): string {
  const d = parseUtcDayKey(dayKey);
  if (!d) {
    return dayKey;
  }
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return utcDayKey(d);
}

function utcInclusiveDayCount(fromKey: string, toKey: string): number {
  const a = parseUtcDayKey(fromKey);
  const b = parseUtcDayKey(toKey);
  if (!a || !b) {
    return 0;
  }
  return (
    Math.floor((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000)) + 1
  );
}

function enumerateUtcDayKeysInclusive(fromKey: string, toKey: string): string[] {
  const keys: string[] = [];
  let cur = fromKey;
  while (cur <= toKey) {
    keys.push(cur);
    cur = addUtcDaysToKey(cur, 1);
  }
  return keys;
}

@Injectable()
export class ReferralLinksService {
  constructor(private readonly redis: RedisService) {}

  private get referralLinkModel(): mongoose.Model<IReferralLink> {
    return (
      (mongoose.models.ReferralLink as mongoose.Model<IReferralLink>) ??
      mongoose.model<IReferralLink>('ReferralLink', ReferralLinkSchema)
    );
  }

  private get referralLinkStatsModel(): mongoose.Model<IReferralLinkStats> {
    return (
      (mongoose.models.ReferralLinkStats as mongoose.Model<IReferralLinkStats>) ??
      mongoose.model<IReferralLinkStats>(
        'ReferralLinkStats',
        ReferralLinkStatsSchema,
      )
    );
  }

  private get referralLinkFollowDailyModel(): mongoose.Model<IReferralLinkFollowDaily> {
    return (
      (mongoose.models.ReferralLinkFollowDaily as mongoose.Model<IReferralLinkFollowDaily>) ??
      mongoose.model<IReferralLinkFollowDaily>(
        'ReferralLinkFollowDaily',
        ReferralLinkFollowDailySchema,
      )
    );
  }

  private get referralShareModel(): mongoose.Model<IReferralShare> {
    return (
      (mongoose.models.ReferralShare as mongoose.Model<IReferralShare>) ??
      mongoose.model<IReferralShare>('ReferralShare', ReferralShareSchema)
    );
  }

  private get referralPayoutModel(): mongoose.Model<IReferralPayout> {
    return (
      (mongoose.models.ReferralPayout as mongoose.Model<IReferralPayout>) ??
      mongoose.model<IReferralPayout>('ReferralPayout', ReferralPayoutSchema)
    );
  }

  private get customerModel(): mongoose.Model<ICustomer> {
    return (
      (mongoose.models.Customer as mongoose.Model<ICustomer>) ??
      mongoose.model<ICustomer>('Customer', CustomerSchema)
    );
  }

  private get mockOrderModel(): mongoose.Model<IMockOrder> {
    return (
      (mongoose.models.MockOrder as mongoose.Model<IMockOrder>) ??
      mongoose.model<IMockOrder>('MockOrder', MockOrderSchema)
    );
  }

  private get eventModel(): mongoose.Model<IEvent> {
    return (
      (mongoose.models.Event as mongoose.Model<IEvent>) ??
      mongoose.model<IEvent>('Event', EventSchema)
    );
  }

  /**
   * Share of referred customers who have at least one paid order on the link owner's events
   * (same rule as getCustomersForReferralLink "purchased"), not orders-per-registration.
   * Denominator: ReferralLinkStats.registrations (not a live Customer count).
   */
  private async recomputeConversionRateForLink(
    referralLinkId: mongoose.Types.ObjectId,
  ): Promise<void> {
    const link = await this.referralLinkModel
      .findById(referralLinkId)
      .select('userId')
      .lean()
      .exec();
    if (!link) {
      return;
    }
    const ownerId = (link as { userId: number }).userId;

    const statsRow = await this.referralLinkStatsModel
      .findOne({ referralLinkId })
      .select('registrations')
      .lean()
      .exec();
    const reg = (statsRow as { registrations?: number } | null)?.registrations ?? 0;

    if (reg === 0) {
      await this.referralLinkStatsModel
        .updateOne({ referralLinkId }, { $set: { conversionRate: 0 } })
        .exec();
      return;
    }

    const eventRows = await this.eventModel
      .find({ creator: ownerId })
      .select('id')
      .lean()
      .exec();
    const eventNumericIds = eventRows.map((e) => (e as { id: number }).id);

    let convertingCustomers = 0;
    if (eventNumericIds.length > 0) {
      const customerCollection = this.customerModel.collection.name;
      const agg = await this.mockOrderModel
        .aggregate<{ n?: number }>([
          {
            $match: {
              status: 'paid',
              event: { $in: eventNumericIds },
            },
          },
          {
            $lookup: {
              from: customerCollection,
              let: { cid: '$customer' },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        { $eq: ['$id', '$$cid'] },
                        { $eq: ['$referralLink', referralLinkId] },
                      ],
                    },
                  },
                },
                { $limit: 1 },
              ],
              as: 'cust',
            },
          },
          { $match: { cust: { $ne: [] } } },
          { $group: { _id: '$customer' } },
          { $count: 'n' },
        ])
        .exec();
      convertingCustomers = agg[0]?.n ?? 0;
    }

    const conv =
      reg > 0
        ? Math.round(((100 * convertingCustomers) / reg) * 100) / 100
        : 0;

    await this.referralLinkStatsModel
      .updateOne({ referralLinkId }, { $set: { conversionRate: conv } })
      .exec();
  }

  async create(dto: CreateReferralLinkDto, userId: string): Promise<IReferralLink> {
    const ownerId = Number(userId);
    const referralCode = dto.referralCode.trim();
    const internalName = dto.internalName.trim();
    const existing = await this.referralLinkModel
      .findOne({ referralCode })
      .exec();
    if (existing) {
      throw new ConflictException('Referral link with this code already exists');
    }
    const nameTaken = await this.referralLinkModel
      .findOne({ internalName })
      .exec();
    if (nameTaken) {
      throw new ConflictException('Referral link with this internal name already exists');
    }

    let created: IReferralLink;
    try {
      created = await this.referralLinkModel.create({
        userId: ownerId,
        internalName,
        source: dto.source.trim(),
        referralCode,
        partnerCabinetPin: dto.partnerCabinetPin.trim(),
        status: dto.status ?? 'active',
        hasReward: dto.hasReward,
        rewardPercent: dto.hasReward ? dto.rewardPercent : 0,
      });
    } catch (e: unknown) {
      const err = e as { code?: number };
      if (err.code === 11000) {
        throw new ConflictException(
          'Referral link with this code or internal name already exists',
        );
      }
      throw e;
    }
    await this.referralLinkStatsModel.create({
      referralLinkId: created._id,
    });
    return created;
  }

  async followByReferralCode(referralCode: string): Promise<void> {
    const trimmed = referralCode.trim();
    if (!trimmed) {
      throw new NotFoundException('Referral link not found');
    }
    const link = await this.referralLinkModel
      .findOne({ referralCode: trimmed, status: 'active' })
      .select('_id')
      .lean()
      .exec();
    if (!link) {
      throw new NotFoundException('Referral link not found');
    }
    const linkDoc = link as unknown as { _id: mongoose.Types.ObjectId };
    const dayKey = utcDayKey(new Date());
    await this.referralLinkFollowDailyModel
      .updateOne(
        { referralLinkId: linkDoc._id, dayKey },
        {
          $inc: { follows: 1 },
          $setOnInsert: { referralLinkId: linkDoc._id, dayKey },
        },
        { upsert: true },
      )
      .exec();
    const stats = await this.referralLinkStatsModel
      .findOneAndUpdate(
        { referralLinkId: linkDoc._id },
        { $inc: { follows: 1 } },
        { new: true },
      )
      .exec();
    if (!stats) {
      throw new InternalServerErrorException('Referral link stats not found');
    }
  }

  /** Resolves id for customer registration; link must exist and be active. */
  /**
   * Call when a customer registers with a referral link so stats.registrations and conversionRate stay correct.
   */
  async incrementRegistrationsForReferralLink(
    referralLinkId: mongoose.Types.ObjectId,
  ): Promise<void> {
    const updatedStats = await this.referralLinkStatsModel
      .findOneAndUpdate(
        { referralLinkId },
        { $inc: { registrations: 1 } },
        { new: true },
      )
      .exec();
    if (!updatedStats) {
      return;
    }
    await this.recomputeConversionRateForLink(referralLinkId);
  }

  /**
   * When a referred customer’s order is paid: record a share only if the event belongs to the referral link owner.
   * Idempotent per MockOrder _id (payment webhook retries).
   */
  async recordReferralShareIfEligible(params: {
    customerReferralLinkId: mongoose.Types.ObjectId | undefined | null;
    eventCreatorUserId: number;
    orderId: mongoose.Types.ObjectId;
    orderPrice: number;
    orderTotalPrice: number;
  }): Promise<void> {
    console.log('recordReferralShareIfEligible', params);
    const rawId = params.customerReferralLinkId;
    if (rawId == null) {
      return;
    }
    const linkOid =
      rawId instanceof mongoose.Types.ObjectId
        ? rawId
        : new mongoose.Types.ObjectId(String(rawId));

    const link = await this.referralLinkModel
      .findOne({ _id: linkOid, status: 'active' })
      .select('userId hasReward rewardPercent')
      .lean()
      .exec();
    if (!link) {
      return;
    }
    const row = link as {
      userId: number;
      hasReward: boolean;
      rewardPercent: number;
    };

    console.log('recordReferralShareIfEligible row.userId', row.userId);
    console.log('recordReferralShareIfEligible params.eventCreatorUserId', params.eventCreatorUserId);

    if (row.userId !== params.eventCreatorUserId) {
      return;
    }

    const exists = await this.referralShareModel
      .findOne({ orderId: params.orderId })
      .select('_id')
      .lean()
      .exec();
    if (exists) {
      return;
    }

    const earn =
      row.hasReward && row.rewardPercent > 0
        ? Math.round(params.orderPrice * (row.rewardPercent / 100) * 100) / 100
        : 0;
    console.log('recordReferralShareIfEligible earn', earn);

    try {
      await this.referralShareModel.create({
        referralLinkId: linkOid,
        orderId: params.orderId,
        orderPrice: params.orderPrice,
        orderTotalPrice: params.orderTotalPrice,
        shareAmount: earn,
      });
    } catch (e: unknown) {
      const err = e as { code?: number };
      if (err.code === 11000) {
        return;
      }
      throw e;
    }

    const inc: Record<string, number> = {
      totalSalesCount: 1,
      totalSalesAmount: params.orderPrice,
      totalSalesAmountWithVat: params.orderTotalPrice,
      sharesTotalAmount: earn,
    };

    await this.referralLinkStatsModel
      .findOneAndUpdate({ referralLinkId: linkOid }, { $inc: inc }, { new: true })
      .exec();
    await this.recomputeConversionRateForLink(linkOid);
  }

  /**
   * Referral share of an order (MockOrder `_id`) plus its link's paid / total share sums.
   * Used by the admin vault's silent ticket removal preview; null when there is no share.
   */
  async getReferralShareForOrder(
    orderObjectId: mongoose.Types.ObjectId | string,
  ): Promise<{
    raw: Record<string, unknown>;
    referralLinkId: mongoose.Types.ObjectId;
    shareAmount: number;
    orderPrice: number;
    orderTotalPrice: number;
    sharesPaidAmount: number;
    sharesTotalAmount: number;
  } | null> {
    const share = await this.referralShareModel
      .findOne({ orderId: new mongoose.Types.ObjectId(String(orderObjectId)) })
      .lean()
      .exec();
    if (!share) {
      return null;
    }
    const stats = await this.referralLinkStatsModel
      .findOne({ referralLinkId: share.referralLinkId })
      .select('sharesPaidAmount sharesTotalAmount')
      .lean()
      .exec();
    return {
      raw: share as unknown as Record<string, unknown>,
      referralLinkId: share.referralLinkId,
      shareAmount: share.shareAmount ?? 0,
      orderPrice: share.orderPrice ?? 0,
      orderTotalPrice: share.orderTotalPrice ?? 0,
      sharesPaidAmount: stats?.sharesPaidAmount ?? 0,
      sharesTotalAmount: stats?.sharesTotalAmount ?? 0,
    };
  }

  /**
   * Admin vault only (silent ticket removal): scales an order's referral share down to
   * the part of the order that stays — or deletes it with the order — and takes the
   * difference off the link's stats, as if the removed tickets had never been sold.
   * Payouts already made are not touched. Returns the applied stats `$inc`; null when
   * the order has no share.
   */
  async adjustReferralShareForTicketRemoval(
    orderObjectId: mongoose.Types.ObjectId | string,
    factor: number,
    deleteShare: boolean,
  ): Promise<{ statsDelta: Record<string, number> } | null> {
    const share = await this.referralShareModel
      .findOne({ orderId: new mongoose.Types.ObjectId(String(orderObjectId)) })
      .lean()
      .exec();
    if (!share) {
      return null;
    }
    const round = (value: number) => Math.round(value * 100) / 100;
    const f = deleteShare ? 0 : factor;
    const next = {
      orderPrice: round((share.orderPrice ?? 0) * f),
      orderTotalPrice: round((share.orderTotalPrice ?? 0) * f),
      shareAmount: round((share.shareAmount ?? 0) * f),
    };

    if (deleteShare) {
      await this.referralShareModel.deleteOne({ _id: share._id }).exec();
    } else {
      // `timestamps: false`: the share keeps its `updatedAt`, no trace of the removal.
      await this.referralShareModel
        .updateOne({ _id: share._id }, { $set: next }, { timestamps: false })
        .exec();
    }

    const statsDelta: Record<string, number> = {
      totalSalesAmount: -round((share.orderPrice ?? 0) - next.orderPrice),
      totalSalesAmountWithVat: -round(
        (share.orderTotalPrice ?? 0) - next.orderTotalPrice,
      ),
      sharesTotalAmount: -round((share.shareAmount ?? 0) - next.shareAmount),
    };
    if (deleteShare) {
      statsDelta.totalSalesCount = -1;
    }
    await this.referralLinkStatsModel
      .updateOne({ referralLinkId: share.referralLinkId }, { $inc: statsDelta })
      .exec();
    await this.recomputeConversionRateForLink(share.referralLinkId);
    return { statsDelta };
  }

  async resolveReferralLinkForRegistration(
    referralCode: string,
  ): Promise<mongoose.Types.ObjectId> {
    const trimmed = referralCode.trim();
    if (!trimmed) {
      throw new BadRequestException('invalid_referral_link');
    }
    const row = await this.referralLinkModel
      .findOne({ referralCode: trimmed, status: 'active' })
      .select('_id')
      .lean()
      .exec();
    if (!row) {
      throw new BadRequestException('invalid_referral_link');
    }
    return (row as unknown as { _id: mongoose.Types.ObjectId })._id;
  }

  async findAll(userId: string): Promise<ReferralLinkResponseDto[]> {
    const ownerId = Number(userId);
    const rows = (await this.referralLinkModel
      .find({ userId: ownerId })
      .sort({ createdAt: -1 })
      .lean()
      .exec()) as unknown as LeanReferralLink[];

    return rows.map((row) => this.toResponseDto(row));
  }

  async findOne(id: string, userId: string): Promise<ReferralLinkDetailResponseDto> {
    // await new Promise((r) => setTimeout(r, 5000));
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Referral link not found');
    }
    const ownerId = Number(userId);
    const row = (await this.referralLinkModel
      .findOne({ _id: id, userId: ownerId })
      .lean()
      .exec()) as unknown as LeanReferralLink | null;
    if (!row) {
      throw new NotFoundException('Referral link not found');
    }
    const statsRow = (await this.referralLinkStatsModel
      .findOne({ referralLinkId: row._id })
      .lean()
      .exec()) as unknown as LeanReferralLinkStats | null;
    if (!statsRow) {
      throw new InternalServerErrorException('Referral link stats not found');
    }
    return this.toDetailDto(row, this.toStatsDto(statsRow));
  }

  /**
   * Partner cabinet: `id` comes from the cabinet session cookie (ReferralPinCodeGuard).
   */
  async findOneForCabinet(id: string): Promise<ReferralLinkDetailResponseDto> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Referral link not found');
    }
    const row = (await this.referralLinkModel
      .findOne({ _id: id, status: 'active' })
      .lean()
      .exec()) as unknown as LeanReferralLink | null;
    if (!row) {
      throw new NotFoundException('Referral link not found');
    }
    const statsRow = (await this.referralLinkStatsModel
      .findOne({ referralLinkId: row._id })
      .lean()
      .exec()) as unknown as LeanReferralLinkStats | null;
    if (!statsRow) {
      throw new InternalServerErrorException('Referral link stats not found');
    }
    return this.toDetailDto(row, this.toStatsDto(statsRow));
  }

  async verifyCabinetAndOpenSession(dto: VerifyReferralCabinetDto): Promise<{
    sessionToken: string;
    expiresInSeconds: number;
  }> {
    const internalName = dto.internalName.trim();
    const row = await this.referralLinkModel
      .findOne({ internalName, status: 'active' })
      .select('_id partnerCabinetPin')
      .lean()
      .exec();
    if (!row) {
      throw new UnauthorizedException('Invalid name or pin');
    }
    const typed = row as unknown as {
      _id: mongoose.Types.ObjectId;
      partnerCabinetPin: string;
    };
    const stored = typed.partnerCabinetPin.trim();
    const given = dto.pin.trim();
    if (!this.cabinetPinsEqual(stored, given)) {
      throw new UnauthorizedException('Invalid name or pin');
    }
    const linkId = typed._id.toString();
    const sessionToken = randomBytes(32).toString('hex');
    await this.redis.set(
      referralCabinetSessionRedisKey(sessionToken),
      linkId,
      REFERRAL_CABINET_SESSION_TTL_SEC,
    );
    return {
      sessionToken,
      expiresInSeconds: REFERRAL_CABINET_SESSION_TTL_SEC,
    };
  }

  private cabinetPinsEqual(stored: string, given: string): boolean {
    if (!/^\d{4}$/.test(stored) || !/^\d{4}$/.test(given)) {
      return false;
    }
    return timingSafeEqual(Buffer.from(stored, 'utf8'), Buffer.from(given, 'utf8'));
  }

  /**
   * Daily follow counts (UTC days), gap-filled for charting.
   * Optional `from` / `to` as YYYY-MM-DD; default last 90 UTC days through today.
   * Range length capped at 366 UTC days.
   */
  async getFollowsByDay(
    id: string,
    userId: string,
    from?: string,
    to?: string,
  ): Promise<ReferralLinkFollowDayPointDto[]> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Referral link not found');
    }
    const ownerId = Number(userId);
    const row = await this.referralLinkModel
      .findOne({ _id: id, userId: ownerId })
      .select('_id')
      .lean()
      .exec();
    if (!row) {
      throw new NotFoundException('Referral link not found');
    }
    const linkId = row._id as mongoose.Types.ObjectId;
    return this.followsByDayForLinkInRange(linkId, from, to);
  }

  /**
   * Partner cabinet: `id` from session cookie; link must be active.
   */
  async getFollowsByDayForCabinet(
    id: string,
    from?: string,
    to?: string,
  ): Promise<ReferralLinkFollowDayPointDto[]> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Referral link not found');
    }
    const row = await this.referralLinkModel
      .findOne({ _id: id, status: 'active' })
      .select('_id')
      .lean()
      .exec();
    if (!row) {
      throw new NotFoundException('Referral link not found');
    }
    const linkId = row._id as mongoose.Types.ObjectId;
    return this.followsByDayForLinkInRange(linkId, from, to);
  }

  /**
   * Partner cabinet: paginated payout history (newest first); `id` from session cookie.
   */
  async getReferralPayoutsForCabinet(
    id: string,
    page?: number,
    limit?: number,
  ): Promise<ReferralPayoutsPageDto> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Referral link not found');
    }
    const row = await this.referralLinkModel
      .findOne({ _id: id, status: 'active' })
      .select('_id')
      .lean()
      .exec();
    if (!row) {
      throw new NotFoundException('Referral link not found');
    }
    return this.referralPayoutsPageForLink(row._id as mongoose.Types.ObjectId, page, limit);
  }

  /**
   * Organizer/admin: paginated payouts for a referral link owned by `userId`.
   */
  async getReferralPayoutsForOwner(
    id: string,
    userId: string,
    page?: number,
    limit?: number,
  ): Promise<ReferralPayoutsPageDto> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Referral link not found');
    }
    const ownerId = Number(userId);
    const row = await this.referralLinkModel
      .findOne({ _id: id, userId: ownerId })
      .select('_id')
      .lean()
      .exec();
    if (!row) {
      throw new NotFoundException('Referral link not found');
    }
    return this.referralPayoutsPageForLink(row._id as mongoose.Types.ObjectId, page, limit);
  }

  private async referralPayoutsPageForLink(
    linkOid: mongoose.Types.ObjectId,
    page?: number,
    limit?: number,
  ): Promise<ReferralPayoutsPageDto> {
    const pageNum = page != null && page >= 1 ? page : 1;
    const limitNum =
      limit != null && limit >= 1 ? Math.min(limit, 100) : 20;
    const skip = (pageNum - 1) * limitNum;

    const [docs, total] = await Promise.all([
      this.referralPayoutModel
        .find({ referralLinkId: linkOid })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean()
        .exec(),
      this.referralPayoutModel.countDocuments({ referralLinkId: linkOid }).exec(),
    ]);

    const out = new ReferralPayoutsPageDto();
    out.items = (docs as IReferralPayout[]).map((d) => this.toReferralPayoutDto(d));
    out.total = total;
    out.page = pageNum;
    out.limit = limitNum;
    return out;
  }

  private async followsByDayForLinkInRange(
    linkId: mongoose.Types.ObjectId,
    from?: string,
    to?: string,
  ): Promise<ReferralLinkFollowDayPointDto[]> {
    const todayKey = utcDayKey(new Date());
    let fromKey: string;
    let toKey: string;
    if (from !== undefined && from !== '') {
      const fd = parseUtcDayKey(from);
      if (!fd) {
        throw new BadRequestException('Invalid from date; use YYYY-MM-DD (UTC)');
      }
      fromKey = utcDayKey(fd);
    } else {
      fromKey = addUtcDaysToKey(todayKey, -89);
    }
    if (to !== undefined && to !== '') {
      const td = parseUtcDayKey(to);
      if (!td) {
        throw new BadRequestException('Invalid to date; use YYYY-MM-DD (UTC)');
      }
      toKey = utcDayKey(td);
    } else {
      toKey = todayKey;
    }
    if (fromKey > toKey) {
      throw new BadRequestException('from must be on or before to');
    }
    const spanDays = utcInclusiveDayCount(fromKey, toKey);
    if (spanDays > FOLLOWS_BY_DAY_MAX_RANGE_DAYS) {
      throw new BadRequestException(
        `Date range must be at most ${FOLLOWS_BY_DAY_MAX_RANGE_DAYS} days`,
      );
    }
    const dayKeys = enumerateUtcDayKeysInclusive(fromKey, toKey);

    const rows = (await this.referralLinkFollowDailyModel
      .find({
        referralLinkId: linkId,
        dayKey: { $gte: fromKey, $lte: toKey },
      })
      .select('dayKey follows')
      .lean()
      .exec()) as unknown as { dayKey: string; follows: number }[];

    const byDay = new Map(rows.map((r) => [r.dayKey, r.follows ?? 0]));
    return dayKeys.map((date) => {
      const dto = new ReferralLinkFollowDayPointDto();
      dto.date = date;
      dto.follows = byDay.get(date) ?? 0;
      return dto;
    });
  }

  /**
   * Customers who registered with this referral link, paginated.
   * `numberOfOrders` / `purchased` counts paid mock orders for events created by the link owner.
   */
  async getCustomersForReferralLink(
    id: string,
    userId: string,
    page?: number,
    limit?: number,
  ): Promise<ReferralLinkCustomersPageDto> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Referral link not found');
    }
    const ownerId = Number(userId);
    const link = await this.referralLinkModel
      .findOne({ _id: id, userId: ownerId })
      .select('_id userId')
      .lean()
      .exec();
    if (!link) {
      throw new NotFoundException('Referral link not found');
    }
    const linkOid = link._id as mongoose.Types.ObjectId;
    const linkOwnerUserId = (link as { userId: number }).userId;

    const pageNum = page != null && page >= 1 ? page : 1;
    const limitNum =
      limit != null && limit >= 1 ? Math.min(limit, 100) : 20;
    const skip = (pageNum - 1) * limitNum;

    const eventRows = await this.eventModel
      .find({ creator: linkOwnerUserId })
      .select('id')
      .lean()
      .exec();
    const eventNumericIds = eventRows.map((e) => (e as { id: number }).id);

    const filter = { referralLink: linkOid };

    const [customers, total] = await Promise.all([
      this.customerModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .select('id fullname email createdAt')
        .lean()
        .exec(),
      this.customerModel.countDocuments(filter).exec(),
    ]);

    const typedCustomers = customers as {
      id: number;
      fullname: string;
      email: string;
      createdAt: Date;
    }[];

    const orderCounts = new Map<number, number>();
    if (typedCustomers.length > 0 && eventNumericIds.length > 0) {
      const custIds = typedCustomers.map((c) => c.id);
      const agg = await this.mockOrderModel
        .aggregate<{ _id: number; count: number }>([
          {
            $match: {
              customer: { $in: custIds },
              status: 'paid',
              event: { $in: eventNumericIds },
            },
          },
          { $group: { _id: '$customer', count: { $sum: 1 } } },
        ])
        .exec();
      for (const row of agg) {
        orderCounts.set(row._id, row.count);
      }
    }

    const items: ReferralLinkCustomerDto[] = typedCustomers.map((c) => {
      const numberOfOrders = orderCounts.get(c.id) ?? 0;
      const dto = new ReferralLinkCustomerDto();
      dto.id = c.id;
      dto.name = c.fullname;
      dto.email = c.email;
      dto.dateOfRegistration = c.createdAt;
      dto.status = numberOfOrders > 0 ? 'purchased' : 'registered';
      dto.numberOfOrders = numberOfOrders;
      return dto;
    });

    const result = new ReferralLinkCustomersPageDto();
    result.items = items;
    result.total = total;
    result.page = pageNum;
    result.limit = limitNum;
    return result;
  }

  async update(
    id: string,
    userId: string,
    dto: UpdateReferralLinkDto,
  ): Promise<ReferralLinkDetailResponseDto> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Referral link not found');
    }
    const ownerId = Number(userId);
    const existing = await this.referralLinkModel
      .findOne({ _id: id, userId: ownerId })
      .exec();
    if (!existing) {
      throw new NotFoundException('Referral link not found');
    }

    if (dto.referralCode !== undefined) {
      const code = dto.referralCode.trim();
      const conflict = await this.referralLinkModel
        .findOne({ referralCode: code, _id: { $ne: existing._id } })
        .exec();
      if (conflict) {
        throw new ConflictException('Referral link with this code already exists');
      }
    }

    if (dto.internalName !== undefined) {
      const internalName = dto.internalName.trim();
      const nameConflict = await this.referralLinkModel
        .findOne({ internalName, _id: { $ne: existing._id } })
        .exec();
      if (nameConflict) {
        throw new ConflictException('Referral link with this internal name already exists');
      }
    }

    const $set: Record<string, unknown> = {};

    if (dto.internalName !== undefined) {
      $set.internalName = dto.internalName.trim();
    }
    if (dto.source !== undefined) {
      $set.source = dto.source.trim();
    }
    if (dto.referralCode !== undefined) {
      $set.referralCode = dto.referralCode.trim();
    }
    if (dto.partnerCabinetPin !== undefined) {
      $set.partnerCabinetPin = dto.partnerCabinetPin.trim();
    }
    if (dto.status !== undefined) {
      $set.status = dto.status;
    }

    let hasReward = existing.hasReward;
    let rewardPercent = existing.rewardPercent;
    if (dto.hasReward !== undefined) {
      hasReward = dto.hasReward;
    }
    if (dto.rewardPercent !== undefined) {
      rewardPercent = dto.rewardPercent;
    }
    if (!hasReward) {
      rewardPercent = 0;
    }
    if (dto.hasReward !== undefined || dto.rewardPercent !== undefined) {
      $set.hasReward = hasReward;
      $set.rewardPercent = rewardPercent;
    }

    if (Object.keys($set).length > 0) {
      try {
        await this.referralLinkModel
          .updateOne({ _id: id, userId: ownerId }, { $set })
          .exec();
      } catch (e: unknown) {
        const err = e as { code?: number };
        if (err.code === 11000) {
          throw new ConflictException(
            'Referral link with this code or internal name already exists',
          );
        }
        throw e;
      }
    }

    return this.findOne(id, userId);
  }

  async remove(id: string, userId: string): Promise<void> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Referral link not found');
    }
    const ownerId = Number(userId);
    const deleted = await this.referralLinkModel
      .findOneAndDelete({ _id: id, userId: ownerId })
      .exec();
    if (!deleted) {
      throw new NotFoundException('Referral link not found');
    }
    await this.referralLinkStatsModel
      .deleteOne({ referralLinkId: deleted._id })
      .exec();
    await this.referralLinkFollowDailyModel
      .deleteMany({ referralLinkId: deleted._id })
      .exec();
    await this.referralShareModel.deleteMany({ referralLinkId: deleted._id }).exec();
    await this.referralPayoutModel.deleteMany({ referralLinkId: deleted._id }).exec();
  }

  /**
   * Records a referral share payout: increments ReferralLinkStats.sharesPaidAmount and
   * stores a snapshot of shares totals/paid before and after.
   */
  async recordReferralPayout(
    referralLinkId: string,
    userId: string,
    paidAmountRaw: number,
  ): Promise<ReferralPayoutResponseDto> {
    if (!mongoose.Types.ObjectId.isValid(referralLinkId)) {
      throw new NotFoundException('Referral link not found');
    }
    const paidAmount =
      Math.round(Number(paidAmountRaw) * 100) / 100;
    if (!Number.isFinite(paidAmount) || paidAmount <= 0) {
      throw new BadRequestException('paidAmount must be a positive number');
    }

    const ownerId = Number(userId);
    const link = await this.referralLinkModel
      .findOne({ _id: referralLinkId, userId: ownerId })
      .select('_id')
      .lean()
      .exec();
    if (!link) {
      throw new NotFoundException('Referral link not found');
    }
    const linkOid = new mongoose.Types.ObjectId(referralLinkId);

    const stats = await this.referralLinkStatsModel
      .findOne({ referralLinkId: linkOid })
      .lean()
      .exec();
    if (!stats) {
      throw new NotFoundException('Referral link stats not found');
    }
    const statsRow = stats as unknown as LeanReferralLinkStats & {
      _id: mongoose.Types.ObjectId;
    };
    const sharesTotal = Math.round((statsRow.sharesTotalAmount ?? 0) * 100) / 100;
    const sharesPaid = Math.round((statsRow.sharesPaidAmount ?? 0) * 100) / 100;
    const outstanding = Math.round((sharesTotal - sharesPaid) * 100) / 100;
    if (paidAmount > outstanding) {
      throw new BadRequestException(
        `Payout exceeds outstanding referral share balance (${outstanding})`,
      );
    }

    const updated = await this.referralLinkStatsModel
      .findOneAndUpdate(
        {
          _id: statsRow._id,
          sharesPaidAmount: statsRow.sharesPaidAmount,
        },
        { $inc: { sharesPaidAmount: paidAmount } },
        { new: true },
      )
      .exec();
    if (!updated) {
      throw new ConflictException(
        'Referral stats were updated concurrently; retry the payout',
      );
    }

    const sharesTotalAfter =
      Math.round((updated.sharesTotalAmount ?? 0) * 100) / 100;
    const sharesPaidAfter =
      Math.round((updated.sharesPaidAmount ?? 0) * 100) / 100;

    const payoutDoc = await this.referralPayoutModel.create({
      referralLinkId: linkOid,
      paidAmount,
      sharesTotalAmountBefore: sharesTotal,
      sharesTotalAmountAfter: sharesTotalAfter,
      sharesPaidAmountBefore: sharesPaid,
      sharesPaidAmountAfter: sharesPaidAfter,
    });

    return this.toReferralPayoutDto(payoutDoc);
  }

  private toResponseDto(row: LeanReferralLink): ReferralLinkResponseDto {
    const dto = new ReferralLinkResponseDto();
    dto.id = row._id.toString();
    dto.internalName = row.internalName;
    dto.source = row.source;
    dto.referralCode = row.referralCode;
    dto.partnerCabinetPin = row.partnerCabinetPin;
    dto.status = row.status;
    dto.hasReward = row.hasReward;
    dto.rewardPercent = row.rewardPercent;
    dto.createdAt = row.createdAt;
    dto.updatedAt = row.updatedAt;
    return dto;
  }

  private toStatsDto(row: LeanReferralLinkStats): ReferralLinkStatsResponseDto {
    const dto = new ReferralLinkStatsResponseDto();
    dto.follows = row.follows ?? 0;
    dto.registrations = row.registrations ?? 0;
    dto.totalSalesCount = row.totalSalesCount ?? 0;
    dto.totalSalesAmount = row.totalSalesAmount ?? 0;
    dto.totalSalesAmountWithVat = row.totalSalesAmountWithVat ?? 0;
    dto.conversionRate = row.conversionRate ?? 0;
    dto.sharesTotalAmount = row.sharesTotalAmount ?? 0;
    dto.sharesPaidAmount = row.sharesPaidAmount ?? 0;
    dto.createdAt = row.createdAt;
    dto.updatedAt = row.updatedAt;
    return dto;
  }

  private toDetailDto(
    row: LeanReferralLink,
    stats: ReferralLinkStatsResponseDto,
  ): ReferralLinkDetailResponseDto {
    const base = this.toResponseDto(row);
    const dto = new ReferralLinkDetailResponseDto();
    Object.assign(dto, base);
    dto.stats = stats;
    return dto;
  }

  private toReferralPayoutDto(doc: IReferralPayout): ReferralPayoutResponseDto {
    const dto = new ReferralPayoutResponseDto();
    dto.id = String(doc._id);
    dto.referralLinkId = doc.referralLinkId.toString();
    dto.paidAmount = doc.paidAmount;
    dto.sharesTotalAmountBefore = doc.sharesTotalAmountBefore;
    dto.sharesTotalAmountAfter = doc.sharesTotalAmountAfter;
    dto.sharesPaidAmountBefore = doc.sharesPaidAmountBefore;
    dto.sharesPaidAmountAfter = doc.sharesPaidAmountAfter;
    dto.createdAt = doc.createdAt;
    dto.updatedAt = doc.updatedAt;
    return dto;
  }
}
