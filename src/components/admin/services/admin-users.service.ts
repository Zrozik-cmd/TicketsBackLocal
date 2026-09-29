import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import mongoose, { PipelineStage } from "mongoose";
import { UserSchema, IUser } from "../../users/schemas/user.schema";
import { EventSchema, IEvent } from "../../events/schemas/event.schema";
import { ITicket, TicketSchema } from "../../tickets/schemas/ticket.schema";
import {
  EVENT_STATUSES,
  type EventStatus,
} from "../../events/constants/event-status.constant";
import { resolveUserDefaultFeePercents } from "../../events/utils/event-fee.util";
import { UsersService } from "../../users/users.service";
import { AdminUsersQueryDto } from "../dto/admin-users-query.dto";
import { AdminUserEventsQueryDto } from "../dto/admin-user-events-query.dto";
import type {
  AdminUserDetails,
  AdminUserEventListItem,
  AdminUserListItem,
  AdminUsersListResult,
  AdminUserEventsListResult,
  AdminEventsStats,
} from "../types/admin-user.types";
import { venueLabel } from '../../events/utils/venue.util';
import { MediaService } from "../../media/media.service";
import { NotificationService } from "../../../services/NotificationService/notification.service";
import {
  ORGANIZER_VERIFICATION_EMAIL_LOCALES,
  resolveVerificationEmailLocale,
} from "../locales/organizer-verification-email.locales";
import { AdminSchema, IAdmin } from "../schemas/admin.schema";

@Injectable()
export class AdminUsersService {
  private readonly logger = new Logger(AdminUsersService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly mediaService: MediaService,
    private readonly notificationService: NotificationService,
  ) {}

  private get adminModel(): mongoose.Model<IAdmin> {
    return (
      (mongoose.models.Admin as mongoose.Model<IAdmin>) ??
      mongoose.model<IAdmin>("Admin", AdminSchema)
    );
  }

  private get userModel(): mongoose.Model<IUser> {
    return (
      (mongoose.models.User as mongoose.Model<IUser>) ??
      mongoose.model<IUser>("User", UserSchema)
    );
  }

  private get eventModel(): mongoose.Model<IEvent> {
    return (
      (mongoose.models.Event as mongoose.Model<IEvent>) ??
      mongoose.model<IEvent>("Event", EventSchema)
    );
  }

  private get ticketModel(): mongoose.Model<ITicket> {
    return (
      (mongoose.models.Ticket as mongoose.Model<ITicket>) ??
      mongoose.model<ITicket>("Ticket", TicketSchema)
    );
  }

  private organizerDisplayName(user: IUser | undefined): string {
    if (!user) {
      return "";
    }
    const candidates = [
      user.displayName,
      user.companyVenueName,
      user.responsiblePersonFullName,
      user.email,
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) {
        return c.trim();
      }
    }
    return "";
  }

  private computeEventCapacity(event: Pick<IEvent, "sectors">): number {
    let total = 0;
    for (const sector of event.sectors ?? []) {
      for (const zone of sector.zones ?? []) {
        total += zone.seats ?? 0;
      }
    }
    return total;
  }

  private async countTicketsSoldByEventIds(
    eventIds: number[],
  ): Promise<Map<number, number>> {
    const map = new Map<number, number>();
    if (!eventIds.length) {
      return map;
    }
    const rows = await this.ticketModel
      .aggregate<{ _id: number; sold: number }>([
        { $match: { eventId: { $in: eventIds } } },
        { $group: { _id: "$eventId", sold: { $sum: 1 } } },
      ])
      .exec();
    for (const r of rows) {
      map.set(r._id, r.sold);
    }
    return map;
  }

  private computeMinPriceCurrency(event: IEvent): { minPrice: number; currency: string } {
    let minPrice = Infinity;
    let currency = "";
    for (const sector of event.sectors ?? []) {
      for (const zone of sector.zones ?? []) {
        if (zone.isFree) {
          continue;
        }
        const p = zone.price ?? 0;
        if (p < minPrice) {
          minPrice = p;
          currency = zone.currency ?? "";
        }
      }
    }
    if (!Number.isFinite(minPrice)) {
      const first = event.sectors?.[0]?.zones?.[0];
      return { minPrice: 0, currency: first?.currency ?? "" };
    }
    return { minPrice, currency };
  }

  /**
   * Stats for one organizer (`creator` = userId): total tickets sold across all events,
   * and count of currently ACTIVE events.
   */
  async getEventsStats(userId: number): Promise<AdminEventsStats> {
    const exists = await this.userModel.findOne({ id: userId }).select({ id: 1 }).lean().exec();
    if (!exists) {
      throw new NotFoundException();
    }

    const byCreator = { creator: userId };
    const activeOnly = { creator: userId, status: "ACTIVE" as const };

    const [allEventIds, activeEventsCount] = await Promise.all([
      this.eventModel.distinct("id", byCreator),
      this.eventModel.countDocuments(activeOnly).exec(),
    ]);

    const totalTicketsSold =
      allEventIds.length > 0
        ? await this.ticketModel.countDocuments({ eventId: { $in: allEventIds } }).exec()
        : 0;

    return {
      totalTicketsSold,
      activeEventsCount,
    };
  }

  async getUsers(query: AdminUsersQueryDto): Promise<AdminUsersListResult> {
    const page = Math.max(query.page ?? 1, 1);
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const skip = (page - 1) * limit;
    const order = query.order === "asc" ? 1 : -1;
    const sortBy = query.sortBy ?? "createdAt";

    const sortFieldMap: Record<string, string> = {
      createdAt: "createdAt",
      email: "email",
      companyVenueName: "companyVenueName",
      displayName: "displayName",
      responsiblePersonFullName: "responsiblePersonFullName",
      provinceRegion: "provinceRegion",
      country: "country",
      eventsCount: "eventsCount",
    };
    const sortKey = sortFieldMap[sortBy] ?? "createdAt";

    const eventsColl = this.eventModel.collection.name;
    const pipeline: PipelineStage[] = [];

    const search = query.search?.trim();
    if (search) {
      const term = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(term, "i");
      pipeline.push({
        $match: {
          $or: [
            { companyVenueName: re },
            { displayName: re },
            { responsiblePersonFullName: re },
            { email: re },
            { phoneNumber: re },
          ],
        },
      });
    }

    /*
     * Заявки без поля считаются одобренными: аккаунты, заведённые до проверки,
     * работают как работали — иначе включение фичи заморозило бы всех разом.
     */
    const verification = query.verification ?? "all";
    if (verification !== "all") {
      pipeline.push({
        $match:
          verification === "approved"
            ? {
                $or: [
                  { verificationStatus: "approved" },
                  { verificationStatus: { $exists: false } },
                ],
              }
            : { verificationStatus: verification },
      });
    }

    const status = query.status ?? "all";
    pipeline.push({
      $lookup: {
        from: eventsColl,
        let: { uid: "$id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$creator", "$$uid"] },
                  { $eq: ["$status", "ACTIVE"] },
                ],
              },
            },
          },
        ],
        as: "activeEventDocs",
      },
    });
    if (status === "active") {
      pipeline.push({
        $match: { "activeEventDocs.0": { $exists: true } },
      });
    } else if (status === "inactive") {
      pipeline.push({
        $match: { activeEventDocs: { $size: 0 } },
      });
    }

    pipeline.push(
      {
        $lookup: {
          from: eventsColl,
          localField: "id",
          foreignField: "creator",
          as: "eventDocs",
        },
      },
      {
        $addFields: {
          eventsCount: { $size: { $ifNull: ["$eventDocs", []] } },
          status: {
            $cond: [
              { $gt: [{ $size: { $ifNull: ["$activeEventDocs", []] } }, 0] },
              "active",
              "inactive",
            ],
          },
        },
      },
    );

    pipeline.push({
      $facet: {
        totalCount: [{ $count: "count" }],
        rows: [
          { $sort: { [sortKey]: order } },
          { $skip: skip },
          { $limit: limit },
          {
            $project: {
              _id: 0,
              id: 1,
              companyVenueName: 1,
              displayName: 1,
              responsiblePersonFullName: 1,
              email: 1,
              phoneNumber: 1,
              category: 1,
              provinceRegion: 1,
              country: 1,
              eventsCount: 1,
              status: 1,
              verificationStatus: { $ifNull: ["$verificationStatus", "approved"] },
              createdAt: 1,
            },
          },
        ],
      },
    });

    const agg = await this.userModel.aggregate<{
      totalCount: Array<{ count: number }>;
      rows: AdminUserListItem[];
    }>(pipeline);

    const bucket = agg[0] ?? { totalCount: [], rows: [] };
    const total = bucket.totalCount[0]?.count ?? 0;
    const items = bucket.rows ?? [];

    return { items, total, page, limit };
  }

  async getUserEvents(
    userId: number,
    query: AdminUserEventsQueryDto,
  ): Promise<AdminUserEventsListResult> {
    const exists = await this.userModel.findOne({ id: userId }).select({ id: 1 }).lean().exec();
    if (!exists) {
      throw new NotFoundException();
    }

    const sortBy = query.sortBy ?? "createdAt";
    const order = query.order ?? "desc";
    const page = Math.max(query.page ?? 1, 1);
    const pageLimit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const skip = (page - 1) * pageLimit;

    const filter: Record<string, unknown> = { creator: userId };
    if (
      query.status?.trim() &&
      EVENT_STATUSES.includes(query.status as EventStatus)
    ) {
      filter.status = query.status.trim();
    }
    if (query.search?.trim()) {
      const term = query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(term, "i");
      filter.$or = [{ "title.th": re }, { "title.en": re }, { "title.ru": re }];
    }

    const sort: Record<string, 1 | -1> =
      sortBy === "eventDate"
        ? {
            "eventDate.startDate": order === "asc" ? 1 : -1,
            id: order === "asc" ? 1 : -1,
          }
        : { createdAt: order === "asc" ? 1 : -1, id: order === "asc" ? 1 : -1 };

    const [total, raw] = await Promise.all([
      this.eventModel.countDocuments(filter).exec(),
      this.eventModel
        .find(filter)
        .sort(sort)
        .skip(skip)
        .limit(pageLimit)
        .lean()
        .exec() as Promise<IEvent[]>,
    ]);

    const eventIds = raw.map((e) => e.id);
    const [usersById, soldByEvent] = await Promise.all([
      this.usersService.findManyByNumericIds([userId]),
      this.countTicketsSoldByEventIds(eventIds),
    ]);
    const organizer = usersById.get(userId);

    const items: AdminUserEventListItem[] = raw.map((e) => {
      const coverId = Number((e as { coverImage?: unknown }).coverImage);
      const { minPrice, currency } = this.computeMinPriceCurrency(e);
      const ed = e.eventDate;
      const endDate =
        ed.isRange && ed.endDate != null && String(ed.endDate).trim() !== ""
          ? ed.endDate!
          : ed.startDate;
      return {
        id: e.id,
        title: e.title,
        shortDescription: e.description,
        coverImageUrl:
          Number.isFinite(coverId) && coverId > 0 ? `/media/${coverId}` : "",
        startDate: ed.startDate,
        endDate,
        city: e.province?.label ?? "",
        country: "",
        venueName: venueLabel(e.venue),
        status: e.status,
        rejectReason: e.rejectReason,
        minPrice,
        currency,
        soldTickets: soldByEvent.get(e.id) ?? 0,
        allTickets: this.computeEventCapacity(e),
        // Regular events sell per session, so the list has to distinguish them.
        isRecurring: e.recurrence?.enabled === true,
        hiddenFromSite: e.hiddenFromSite === true,
        archivedByOrganizer: e.archivedByOrganizer === true, softDeleted: e.softDeleted === true,
        organizerId: userId,
        organizerDisplayName: this.organizerDisplayName(organizer),
        organizerCompanyVenueName: organizer?.companyVenueName ?? "",
        createdAt: e.createdAt,
      };
    });

    return { items, total, page, limit: pageLimit };
  }

  /**
   * Решение по заявке организатора.
   *
   * Отклонение требует причины: организатору её показывают, и «отказано без
   * объяснений» превращает поддержку в переписку вслепую.
   */
  async reviewOrganizer(
    userId: number,
    action: "approve" | "reject",
    reviewerEmail: string,
    reason?: string,
  ): Promise<AdminUserDetails> {
    const user = await this.userModel.findOne({ id: userId }).exec();
    if (!user) {
      throw new NotFoundException();
    }
    const trimmedReason = reason?.trim();
    if (action === "reject" && !trimmedReason) {
      throw new BadRequestException("verification_reject_reason_required");
    }

    user.verificationStatus = action === "approve" ? "approved" : "rejected";
    user.verificationReviewedAt = new Date();
    user.verificationReviewedBy = await this.resolveReviewerLabel(reviewerEmail);
    user.verificationRejectReason =
      action === "reject" ? trimmedReason : undefined;
    await user.save();

    this.logger.log(
      `Organizer ${userId} ${user.verificationStatus} by ${user.verificationReviewedBy}` +
        (trimmedReason ? `: ${trimmedReason}` : ""),
    );

    /*
     * Письмо — фоном: решение уже сохранено, и падение почты не должно
     * возвращать админу ошибку и провоцировать повторное нажатие.
     */
    void this.sendVerificationEmail(user, action, trimmedReason).catch((error) =>
      this.logger.error(
        `Verification email failed for user ${userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );

    return this.getUserById(userId);
  }

  /** Сколько заявок ждёт решения — для счётчика в сайдбаре админки. */
  async getPendingVerificationCount(): Promise<{ count: number }> {
    const count = await this.userModel
      .countDocuments({ verificationStatus: "pending" })
      .exec();
    return { count };
  }

  /**
   * Письмо организатору о решении по заявке.
   *
   * Одобрение — короткое подтверждение, отказ — причина, иначе человеку
   * некуда идти дальше. Язык письма — русский: кабинет организатора и все
   * документы, которыми он пользуется на этом этапе, тоже русские.
   */
  private async sendVerificationEmail(
    user: IUser,
    action: "approve" | "reject",
    reason?: string,
  ): Promise<void> {
    const to = user.email?.trim();
    if (!to) return;

    const name =
      user.companyVenueName?.trim() ||
      user.responsiblePersonFullName?.trim() ||
      "";

    const locale = resolveVerificationEmailLocale(user.locale);
    const copy =
      ORGANIZER_VERIFICATION_EMAIL_LOCALES[locale][
        action === "approve" ? "approved" : "rejected"
      ];

    const greeting = name
      ? copy.greetingNamed.replace("{{name}}", name)
      : copy.greetingPlain;

    /*
     * Причина ставится сразу после первого абзаца — до совета «исправьте и
     * напишите нам», иначе совет читается раньше, чем сама претензия.
     */
    const lines = [greeting, copy.body[0]];
    if (action === "reject" && copy.reasonLabel && reason) {
      lines.push(`${copy.reasonLabel}: ${reason}`);
    }
    lines.push(...copy.body.slice(1));

    const subject = copy.subject;
    const html = [
      '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111;line-height:1.6">',
      ...lines.map((line) => `<p style="margin:0 0 10px">${line}</p>`),
      `<p style="margin:16px 0 0;color:#666">${copy.signature}</p>`,
      "</div>",
    ].join("");

    await this.notificationService.sendEmail({
      to,
      subject,
      text: lines.join("\n"),
      html,
    });
    /*
     * Именно «передано отправщику», а не «доставлено»: NotificationService
     * гасит свои ошибки внутри и не бросает наружу, поэтому подтвердить
     * доставку отсюда нельзя, а врать в журнале нельзя тем более.
     */
    this.logger.log(
      `Verification email (${action}, ${locale}) handed to mailer for ${to}`,
    );
  }

  /**
   * Выписка DBD для проверки. Файл лежит приватным медиа и по публичному
   * /media/:id не отдаётся — читаем его здесь, уже под админской охраной.
   */
  async getOrganizerDbdDocument(
    userId: number,
  ): Promise<{ file: Buffer; mimeType: string }> {
    const user = await this.userModel
      .findOne({ id: userId })
      .select("companyRegistrationDbdMediaId")
      .lean<IUser>()
      .exec();
    if (!user?.companyRegistrationDbdMediaId) {
      throw new NotFoundException("dbd_document_not_found");
    }
    const media = await this.mediaService.getById(user.companyRegistrationDbdMediaId);
    return { file: media.file, mimeType: media.mimeType };
  }

  /**
   * Подпись автора решения: в запросе лежит id админа, а в журнале нужна
   * почта — по числу через полгода никого не найти.
   */
  private async resolveReviewerLabel(adminId: string): Promise<string> {
    const numeric = Number.parseInt(adminId, 10);
    if (!Number.isFinite(numeric)) return adminId;
    const admin = await this.adminModel
      .findOne({ id: numeric })
      .select("email")
      .lean<IAdmin>()
      .exec();
    return admin?.email ?? adminId;
  }

  async getUserById(userId: number): Promise<AdminUserDetails> {
    const user = await this.userModel
      .findOne({ id: userId })
      .select("-passwordHash")
      .lean<IUser>()
      .exec();

    if (!user) {
      throw new NotFoundException();
    }

    const [eventsCount, activeEventsCount] = await Promise.all([
      this.eventModel.countDocuments({ creator: userId }),
      this.eventModel.countDocuments({ creator: userId, status: "ACTIVE" }),
    ]);

    const status =
      activeEventsCount > 0 ? ("active" as const) : ("inactive" as const);

    const location = [
      user.businessAddress,
      user.city,
      user.provinceRegion,
      user.country,
    ]
      .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
      .map((s) => s.trim())
      .join(", ");

    const defaultFees = resolveUserDefaultFeePercents(user);

    return {
      id: user.id,
      companyVenueName: user.companyVenueName,
      displayName: user.displayName,
      category: user.category,
      status,
      responsiblePersonFullName: user.responsiblePersonFullName,
      email: user.email,
      phoneNumber: user.phoneNumber,
      location,
      createdAt: user.createdAt,
      eventsCount,
      verificationStatus: user.verificationStatus ?? "approved",
      verificationReviewedAt: user.verificationReviewedAt,
      verificationReviewedBy: user.verificationReviewedBy,
      verificationRejectReason: user.verificationRejectReason,
      companyRegistrationDbd: user.companyRegistrationDbd,
      taxRegistrationId: user.taxRegistrationId,
      hasDbdDocument: user.companyRegistrationDbdMediaId != null,
      defaultVatPercent: defaultFees.defaultVatPercent,
      defaultProcessingFeePercent: defaultFees.defaultProcessingFeePercent,
      defaultPlatformFeePercent: defaultFees.defaultPlatformFeePercent,
      defaultAdditionalTicketCostFeePercent:
        defaultFees.defaultAdditionalTicketCostFeePercent,
    };
  }
}
