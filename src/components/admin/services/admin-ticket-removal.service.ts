import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from "@nestjs/common";
import mongoose from "mongoose";
import { EventSchema, IEvent } from "../../events/schemas/event.schema";
import { ITicket, TicketSchema } from "../../tickets/schemas/ticket.schema";
import { IScan, ScanSchema } from "../../tickets/schemas/scan.schema";
import {
  IMockOrder,
  MockOrderSchema,
} from "../../mock-orders/schemas/mock-order.schema";
import {
  resolvePaymentMethodLabel,
  roundMoney,
} from "../../mock-orders/utils/mock-order-refund.util";
import {
  CashScanEventSchema,
  ICashScanEvent,
} from "../../cash-encashments/schemas/cash-scan-event.schema";
import {
  ITelegramNotificationLog,
  TelegramNotificationLogSchema,
} from "../../telegram-notifications/schemas/telegram-notification-log.schema";
import { CashEncashmentsService } from "../../cash-encashments/cash-encashments.service";
import { ReferralLinksService } from "../../referral-links/referral-links.service";
import { PromocodesService } from "../../promocodes/promocodes.service";
import { buildSectorZoneNames } from "../../ticket-registry/utils/sector-zone-names.util";
import {
  ITicketRemoval,
  TicketRemovalSchema,
  type TicketRemovalState,
} from "../schemas/ticket-removal.schema";
import {
  planTicketRemoval,
  ticketRemovalOrderMoney,
  type TicketRemovalPlan,
} from "../utils/ticket-removal-plan.util";
import type {
  TicketRemovalBlocker,
  TicketRemovalPreview,
  TicketRemovalResult,
  TicketRemovalWarning,
} from "../types/admin-vault.types";
import { AdminsService } from "./admins.service";

export const TICKET_REMOVAL_ERROR = {
  BLOCKED: "ticket_remove_blocked",
  MULTIPLE_ORDERS: "ticket_remove_multiple_orders",
  CONFIRMATION_MISMATCH: "ticket_remove_confirmation_mismatch",
  STATE_CHANGED: "ticket_remove_state_changed",
  ARCHIVE_FAILED: "ticket_remove_archive_failed",
  ROLLED_BACK: "ticket_remove_rolled_back",
  ROLLBACK_FAILED: "ticket_remove_rollback_failed",
} as const;

/** A removal still `archived` after this long is not in flight any more: it was interrupted. */
const UNFINISHED_REMOVAL_AFTER_MS = 2 * 60 * 1000;

type CashSaleRow = NonNullable<
  Awaited<ReturnType<CashEncashmentsService["getSaleRowForOrder"]>>
>;
type ReferralShareRow = NonNullable<
  Awaited<ReturnType<ReferralLinksService["getReferralShareForOrder"]>>
>;
type SuccessfulPlan = Extract<TicketRemovalPlan, { ok: true }>;

/** Everything read once for a removal: shared by the preview and the removal itself. */
type RemovalContext = {
  ticketIds: number[];
  tickets: ITicket[];
  missingTicketIds: number[];
  orderIds: number[];
  order: IMockOrder | null;
  plan: TicketRemovalPlan | null;
  cashSale: CashSaleRow | null;
  referralShare: ReferralShareRow | null;
  preview: TicketRemovalPreview;
};

/**
 * Admin vault: removes tickets as if they had never been sold. No refund is recorded —
 * the order is rescaled (or deleted when no tickets remain), the CASH ledger sale row,
 * referral share and promo usage follow, the tickets and their scans are deleted.
 *
 * Safety: the server recomputes the typed phrase and every blocker; a full archive copy
 * (`ticketremovals`) is written before anything changes; the order write is a
 * compare-and-swap on its `updatedAt`; if the tickets cannot be deleted the order is
 * restored from the archive copy. Side effects after that are best effort and reported.
 */
@Injectable()
export class AdminTicketRemovalService {
  private readonly logger = new Logger(AdminTicketRemovalService.name);

  constructor(
    private readonly cashEncashmentsService: CashEncashmentsService,
    private readonly referralLinksService: ReferralLinksService,
    private readonly promocodesService: PromocodesService,
    private readonly adminsService: AdminsService,
  ) {}

  private get ticketModel(): mongoose.Model<ITicket> {
    return (
      (mongoose.models.Ticket as mongoose.Model<ITicket>) ??
      mongoose.model<ITicket>("Ticket", TicketSchema)
    );
  }

  private get mockOrderModel(): mongoose.Model<IMockOrder> {
    return (
      (mongoose.models.MockOrder as mongoose.Model<IMockOrder>) ??
      mongoose.model<IMockOrder>("MockOrder", MockOrderSchema)
    );
  }

  private get eventModel(): mongoose.Model<IEvent> {
    return (
      (mongoose.models.Event as mongoose.Model<IEvent>) ??
      mongoose.model<IEvent>("Event", EventSchema)
    );
  }

  private get scanModel(): mongoose.Model<IScan> {
    return (
      (mongoose.models.Scan as mongoose.Model<IScan>) ??
      mongoose.model<IScan>("Scan", ScanSchema)
    );
  }

  private get cashScanEventModel(): mongoose.Model<ICashScanEvent> {
    return (
      (mongoose.models.CashScanEvent as mongoose.Model<ICashScanEvent>) ??
      mongoose.model<ICashScanEvent>("CashScanEvent", CashScanEventSchema)
    );
  }

  private get telegramLogModel(): mongoose.Model<ITelegramNotificationLog> {
    return (
      (mongoose.models
        .TelegramNotificationLog as mongoose.Model<ITelegramNotificationLog>) ??
      mongoose.model<ITelegramNotificationLog>(
        "TelegramNotificationLog",
        TelegramNotificationLogSchema,
      )
    );
  }

  private get ticketRemovalModel(): mongoose.Model<ITicketRemoval> {
    return (
      (mongoose.models.TicketRemoval as mongoose.Model<ITicketRemoval>) ??
      mongoose.model<ITicketRemoval>("TicketRemoval", TicketRemovalSchema)
    );
  }

  private confirmationPhrase(
    ticketIds: number[],
    tickets: ITicket[],
    orderIds: number[],
  ): string {
    if (ticketIds.length === 1 && tickets.length === 1) {
      return `REMOVE ${tickets[0].code}`;
    }
    if (orderIds.length === 1) {
      return `REMOVE ${ticketIds.length} TICKETS FROM ORDER ${orderIds[0]}`;
    }
    return `REMOVE ${ticketIds.length} TICKETS`;
  }

  async getPreview(ticketIds: number[]): Promise<TicketRemovalPreview> {
    return (await this.buildContext(ticketIds)).preview;
  }

  /**
   * An earlier removal of this order that never reached a final state: `rollback_failed`,
   * or still `archived` long after a removal takes (the process died mid-way). Its side
   * effects may be missing, so nothing else on this order may be removed until a developer
   * has looked at it.
   */
  private async findUnfinishedRemoval(
    orderId: number,
  ): Promise<Pick<ITicketRemoval, "_id" | "state"> | null> {
    const stuckBefore = new Date(Date.now() - UNFINISHED_REMOVAL_AFTER_MS);
    const row = await this.ticketRemovalModel
      .findOne({
        orderId,
        $or: [
          { state: "rollback_failed" },
          { state: "archived", createdAt: { $lt: stuckBefore } },
        ],
      })
      .sort({ createdAt: -1 })
      .select({ _id: 1, state: 1 })
      .lean()
      .exec();
    return (row as Pick<ITicketRemoval, "_id" | "state"> | null) ?? null;
  }

  /** Reads tickets, their order and linked money records, and computes the full preview. */
  private async buildContext(rawTicketIds: number[]): Promise<RemovalContext> {
    const ticketIds = [...new Set(rawTicketIds)].sort((a, b) => a - b);
    const tickets = (await this.ticketModel
      .find({ id: { $in: ticketIds } })
      .lean()
      .exec()) as ITicket[];
    tickets.sort((a, b) => a.id - b.id);
    const foundIds = new Set(tickets.map((t) => t.id));
    const missingTicketIds = ticketIds.filter((id) => !foundIds.has(id));
    const orderIds = [...new Set(tickets.map((t) => t.orderId))];

    const blockers: TicketRemovalBlocker[] = [];
    const warnings: TicketRemovalWarning[] = [];
    if (missingTicketIds.length) {
      blockers.push("ticket_not_found");
    }
    if (orderIds.length > 1) {
      blockers.push("multiple_orders");
    }

    let order: IMockOrder | null = null;
    let plan: TicketRemovalPlan | null = null;
    let cashSale: CashSaleRow | null = null;
    let referralShare: ReferralShareRow | null = null;
    let event: Pick<IEvent, "sectors"> | null = null;
    let liveTicketCount: number | null = null;
    let lineTicketCount: number | null = null;
    let unfinished: Pick<ITicketRemoval, "_id" | "state"> | null = null;

    if (orderIds.length === 1) {
      const [orderDoc, eventDoc, unfinishedDoc] = await Promise.all([
        this.mockOrderModel.findOne({ id: orderIds[0] }).lean().exec(),
        this.eventModel
          .findOne({ id: tickets[0].eventId })
          .select({ sectors: 1 })
          .lean()
          .exec(),
        this.findUnfinishedRemoval(orderIds[0]),
      ]);
      order = orderDoc as IMockOrder | null;
      event = eventDoc as Pick<IEvent, "sectors"> | null;
      unfinished = unfinishedDoc;

      // Checked even without the order: an interrupted removal may have deleted it already.
      if (unfinished) {
        blockers.push("removal_unfinished");
      }
      if (!order) {
        blockers.push("order_not_found");
      } else {
        if (order.status !== "paid") {
          blockers.push("order_not_paid");
        }
        if (order.refundStatus === "refund_in_progress") {
          blockers.push("refund_in_progress");
        }
        plan = planTicketRemoval(order, tickets);
        if (!plan.ok) {
          blockers.push("order_line_mismatch");
        }
        // The plan trusts the order lines; they must describe exactly the tickets that exist,
        // otherwise a half-applied earlier removal (or unfinished issuing) would orphan tickets.
        lineTicketCount = (order.tickets ?? []).reduce(
          (sum, line) => sum + (line.count ?? 0),
          0,
        );
        liveTicketCount = await this.ticketModel
          .countDocuments({ orderId: order.id })
          .exec();
        if (liveTicketCount !== lineTicketCount) {
          blockers.push("order_tickets_mismatch");
        }
        const [sale, share] = await Promise.all([
          order.paymentMethod === "CASH"
            ? this.cashEncashmentsService.getSaleRowForOrder(order.id)
            : Promise.resolve(null),
          this.referralLinksService.getReferralShareForOrder(
            order._id as mongoose.Types.ObjectId,
          ),
        ]);
        cashSale = sale;
        referralShare = share;
        if (order.paymentMethod === "CASH" && !cashSale) {
          blockers.push("cash_sale_row_missing");
        }
      }
    }

    const okPlan = plan?.ok ? plan : null;
    const usedTickets = tickets.filter((t) => t.status === "USED").length;
    const isCash = order?.paymentMethod === "CASH";
    const paymentMethodLabel = order
      ? isCash
        ? "CASH"
        : resolvePaymentMethodLabel(order.paymentCurrency, order.paymentMethod)
      : null;

    let cashLedger: TicketRemovalPreview["cashLedger"] = null;
    if (order && isCash && cashSale && okPlan) {
      const saleAfter =
        okPlan.action === "delete"
          ? null
          : roundMoney(Number(okPlan.after?.total_price ?? 0));
      cashLedger = {
        cashierId: cashSale.cashierId,
        cashierEmail: cashSale.cashierEmail,
        saleBefore: cashSale.amount,
        saleAfter,
        tillBefore: cashSale.till,
        tillAfter: roundMoney(cashSale.till - cashSale.amount + (saleAfter ?? 0)),
      };
    }

    let referral: TicketRemovalPreview["referral"] = null;
    if (referralShare && okPlan) {
      const shareAfter =
        okPlan.action === "delete"
          ? null
          : roundMoney(referralShare.shareAmount * okPlan.factor);
      const sharesTotalAfter = roundMoney(
        referralShare.sharesTotalAmount -
          (referralShare.shareAmount - (shareAfter ?? 0)),
      );
      referral = {
        shareBefore: referralShare.shareAmount,
        shareAfter,
        paidOutExceeds: referralShare.sharesPaidAmount > sharesTotalAfter,
      };
    }

    const promo: TicketRemovalPreview["promo"] =
      order?.promoCodeId && okPlan && okPlan.promoDecrement > 0
        ? { promoCodeId: order.promoCodeId, decrement: okPlan.promoDecrement }
        : null;

    if (usedTickets > 0) warnings.push("ticket_used");
    if (okPlan?.action === "delete") warnings.push("order_deleted");
    if (order && isCash) warnings.push("cash_order");
    if (cashLedger && cashLedger.tillAfter < 0) warnings.push("cash_till_negative");
    if (order && !isCash) warnings.push("payment_provider_record");
    if (referralShare) warnings.push("referral_share");
    if (referral?.paidOutExceeds) warnings.push("referral_paid_out_exceeds");
    if (order?.promoCodeId) warnings.push("promo_order");
    if (order?.ticketEmailStatus === "sent") warnings.push("tickets_email_sent");
    warnings.push("scanner_offline_cache", "external_notifications");

    const names = event ? buildSectorZoneNames(event, "en") : null;

    const preview: TicketRemovalPreview = {
      confirmationPhrase: this.confirmationPhrase(ticketIds, tickets, orderIds),
      canRemove: blockers.length === 0,
      blockers,
      blockerDetails: {
        missingTicketIds,
        orderStatus: order?.status ?? null,
        liveTicketCount,
        lineTicketCount,
        unfinishedRemovalId: unfinished ? String(unfinished._id) : null,
        unfinishedRemovalState: unfinished?.state ?? null,
      },
      warnings,
      warningDetails: { usedTickets, paymentMethodLabel },
      order:
        order && okPlan
          ? {
              id: order.id,
              status: order.status,
              paymentMethod: order.paymentMethod ?? null,
              paymentMethodLabel: paymentMethodLabel ?? "",
              paymentCurrency: order.paymentCurrency,
              updatedAt: new Date(order.updatedAt).toISOString(),
              action: okPlan.action,
              before: ticketRemovalOrderMoney(order, okPlan.countBefore),
              after: okPlan.after
                ? ticketRemovalOrderMoney(
                    { ...order, ...okPlan.after } as IMockOrder,
                    okPlan.countAfter,
                  )
                : null,
            }
          : null,
      cashLedger,
      referral,
      promo,
      tickets: tickets.map((t) => ({
        id: t.id,
        code: t.code,
        status: t.status,
        sectorName: names ? names.sectorName(t.sector) : t.sector,
        zoneName: names ? names.zoneName(t.sector, t.zone) : t.zone,
        price: t.price,
        currency: t.currency,
        session:
          typeof t.session === "number"
            ? {
                date: t.sessionDate ?? null,
                start: t.sessionStart ?? null,
                end: t.sessionEnd ?? null,
              }
            : null,
      })),
    };

    return {
      ticketIds,
      tickets,
      missingTicketIds,
      orderIds,
      order,
      plan,
      cashSale,
      referralShare,
      preview,
    };
  }

  /** Best effort: the archive state is audit data and must never fail the request. */
  private async updateArchive(
    archiveId: unknown,
    set: Partial<
      Pick<ITicketRemoval, "sideEffectErrors" | "referralStatsDelta">
    > & { state: TicketRemovalState },
  ): Promise<void> {
    try {
      await this.ticketRemovalModel
        .updateOne({ _id: archiveId }, { $set: set })
        .exec();
    } catch (err) {
      this.logger.error(
        `Could not set ticketremovals ${String(archiveId)} state=${set.state}: ${(err as Error).message}`,
      );
    }
  }

  async remove(
    ticketIds: number[],
    confirmation: string,
    expectedOrderUpdatedAt: string,
    adminId: string,
  ): Promise<TicketRemovalResult> {
    const ctx = await this.buildContext(ticketIds);
    if (ctx.missingTicketIds.length) {
      throw new ConflictException(TICKET_REMOVAL_ERROR.BLOCKED);
    }
    if (ctx.orderIds.length > 1) {
      throw new BadRequestException(TICKET_REMOVAL_ERROR.MULTIPLE_ORDERS);
    }
    const { order, plan } = ctx;
    if (!ctx.preview.canRemove || !order || !plan?.ok) {
      this.logger.warn(
        `Ticket removal blocked (${ctx.preview.blockers.join(",")}) for tickets ${ctx.ticketIds.join(",")} (adminId=${adminId})`,
      );
      throw new ConflictException(TICKET_REMOVAL_ERROR.BLOCKED);
    }
    if (
      typeof confirmation !== "string" ||
      confirmation.trim() !== ctx.preview.confirmationPhrase
    ) {
      throw new BadRequestException(TICKET_REMOVAL_ERROR.CONFIRMATION_MISMATCH);
    }
    const orderUpdatedAt = new Date(order.updatedAt);
    if (orderUpdatedAt.toISOString() !== expectedOrderUpdatedAt) {
      throw new ConflictException(TICKET_REMOVAL_ERROR.STATE_CHANGED);
    }

    const okPlan: SuccessfulPlan = plan;
    const adminEmail = await this.resolveAdminEmail(adminId);
    const orderId = order.id;
    const removedTicketIds = ctx.tickets.map((t) => t.id);
    const deletesOrder = okPlan.action === "delete";
    // `orderId`/ticket ids go into deleteMany filters below: an undefined value there
    // would widen the filter, so refuse anything that is not a concrete id.
    if (
      !Number.isFinite(orderId) ||
      !removedTicketIds.length ||
      removedTicketIds.some((ticketId) => !Number.isFinite(ticketId))
    ) {
      throw new ConflictException(TICKET_REMOVAL_ERROR.BLOCKED);
    }

    // Archive first: if it cannot be written, nothing changes.
    let archive: ITicketRemoval;
    try {
      const [scans, cashScanEvents, telegramLogs] = await Promise.all([
        this.scanModel.find({ id: { $in: removedTicketIds } }).lean().exec(),
        deletesOrder
          ? this.cashScanEventModel.find({ orderId }).lean().exec()
          : Promise.resolve([]),
        deletesOrder
          ? this.telegramLogModel.find({ orderId }).lean().exec()
          : Promise.resolve([]),
      ]);
      archive = await this.ticketRemovalModel.create({
        orderId,
        eventId: order.event,
        ticketIds: removedTicketIds,
        ticketCodes: ctx.tickets.map((t) => t.code),
        orderAction: okPlan.action,
        tickets: ctx.tickets,
        orderBefore: order,
        orderAfterSet: okPlan.after,
        cashSaleRowBefore: ctx.cashSale?.raw ?? null,
        cashSaleAmountAfter:
          ctx.cashSale && !deletesOrder
            ? roundMoney(Number(okPlan.after?.total_price ?? 0))
            : null,
        referralShareBefore: ctx.referralShare?.raw ?? null,
        referralStatsDelta: null,
        promo: ctx.preview.promo
          ? {
              promoCodeId: ctx.preview.promo.promoCodeId,
              customerId: order.customer,
              decrement: ctx.preview.promo.decrement,
            }
          : null,
        scans,
        cashScanEvents,
        telegramLogs,
        confirmation: confirmation.trim(),
        removedByAdminId: Number.isFinite(Number(adminId))
          ? Number(adminId)
          : null,
        removedByAdminEmail: adminEmail,
        state: "archived",
      });
    } catch (err) {
      this.logger.error(
        `Ticket removal aborted for order ${orderId}: archive write failed (adminId=${adminId}): ${(err as Error).message}`,
      );
      throw new InternalServerErrorException(
        TICKET_REMOVAL_ERROR.ARCHIVE_FAILED,
      );
    }

    // Compare-and-swap: a payment, refund or another removal since the preview wins.
    const casFilter = {
      _id: order._id,
      status: "paid",
      refundStatus: { $ne: "refund_in_progress" },
      updatedAt: orderUpdatedAt,
    };
    let swapped: boolean;
    try {
      if (deletesOrder) {
        swapped =
          (await this.mockOrderModel.deleteOne(casFilter).exec())
            .deletedCount > 0;
      } else {
        // Default timestamps bump updatedAt: that is the lock for a concurrent removal.
        swapped =
          (
            await this.mockOrderModel
              .updateOne(casFilter, { $set: okPlan.after as Record<string, unknown> })
              .exec()
          ).matchedCount > 0;
      }
    } catch (err) {
      await this.updateArchive(archive._id, { state: "aborted" });
      this.logger.error(
        `Ticket removal aborted for order ${orderId}: order write failed (archive=${String(archive._id)}): ${(err as Error).message}`,
      );
      throw err;
    }
    if (!swapped) {
      await this.updateArchive(archive._id, { state: "aborted" });
      throw new ConflictException(TICKET_REMOVAL_ERROR.STATE_CHANGED);
    }

    let restoreOrder = false;
    try {
      const { deletedCount } = await this.ticketModel
        .deleteMany({ id: { $in: removedTicketIds }, orderId })
        .exec();
      if (deletedCount !== removedTicketIds.length) {
        this.logger.warn(
          `Ticket removal for order ${orderId}: deleted ${deletedCount} of ${removedTicketIds.length} tickets (archive=${String(archive._id)})`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Ticket removal for order ${orderId}: ticket delete failed, checking what is left (archive=${String(archive._id)}): ${(err as Error).message}`,
      );
      // The driver can throw after the server applied the delete, fully or in part:
      // the order is restored only when every ticket is verifiably still there.
      let ticketsLeft: number | null = null;
      try {
        ticketsLeft = await this.ticketModel
          .countDocuments({ id: { $in: removedTicketIds }, orderId })
          .exec();
      } catch (countErr) {
        this.logger.error(
          `Ticket removal for order ${orderId}: could not count the remaining tickets (archive=${String(archive._id)}): ${(countErr as Error).message}`,
        );
      }
      if (ticketsLeft === removedTicketIds.length) {
        restoreOrder = true;
      } else if (ticketsLeft === 0) {
        // Deleted after all: the removal is applied, finish it below.
        this.logger.warn(
          `Ticket removal for order ${orderId}: the tickets were deleted despite the error, continuing (archive=${String(archive._id)})`,
        );
      } else {
        await this.updateArchive(archive._id, { state: "rollback_failed" });
        this.logger.error(
          `CRITICAL: order ${orderId} changed by a ticket removal, ${ticketsLeft ?? "unknown"} of ${removedTicketIds.length} tickets left; neither restored nor finished, see ticketremovals ${String(archive._id)}`,
        );
        throw new InternalServerErrorException(
          TICKET_REMOVAL_ERROR.ROLLBACK_FAILED,
        );
      }
    }
    if (restoreOrder) {
      try {
        // Raw driver writes keep the original _id and timestamps; no plugin runs.
        if (deletesOrder) {
          await this.mockOrderModel.collection.insertOne(
            order as unknown as mongoose.AnyObject,
          );
        } else {
          await this.mockOrderModel.collection.replaceOne(
            { _id: order._id as mongoose.Types.ObjectId },
            order as unknown as mongoose.AnyObject,
          );
        }
      } catch (restoreErr) {
        await this.updateArchive(archive._id, { state: "rollback_failed" });
        this.logger.error(
          `CRITICAL: order ${orderId} changed by a ticket removal but could not be restored; restore from ticketremovals ${String(archive._id)}: ${(restoreErr as Error).message}`,
        );
        throw new InternalServerErrorException(
          TICKET_REMOVAL_ERROR.ROLLBACK_FAILED,
        );
      }
      await this.updateArchive(archive._id, { state: "rolled_back" });
      throw new InternalServerErrorException(TICKET_REMOVAL_ERROR.ROLLED_BACK);
    }

    // The tickets are gone: everything below is best effort and never throws.
    const sideEffectErrors: string[] = [];
    const sideEffect = async (code: string, run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (err) {
        sideEffectErrors.push(code);
        this.logger.error(
          `Ticket removal for order ${orderId}: ${code} (archive=${String(archive._id)}): ${(err as Error).message}`,
        );
      }
    };

    if (ctx.cashSale) {
      await sideEffect("cash_ledger_update_failed", async () => {
        const rewritten =
          await this.cashEncashmentsService.rewriteSaleRowForTicketRemoval(
            orderId,
            deletesOrder ? null : Number(okPlan.after?.total_price ?? 0),
          );
        if (!rewritten) {
          throw new Error("cash ledger sale row not found");
        }
      });
    }
    let referralStatsDelta: Record<string, number> | null = null;
    if (ctx.referralShare) {
      await sideEffect("referral_update_failed", async () => {
        const res =
          await this.referralLinksService.adjustReferralShareForTicketRemoval(
            order._id as mongoose.Types.ObjectId,
            okPlan.factor,
            deletesOrder,
          );
        referralStatsDelta = res?.statsDelta ?? null;
      });
    }
    if (order.promoCodeId && okPlan.promoDecrement > 0) {
      await sideEffect("promo_update_failed", () =>
        this.promocodesService.decrementCustomerPromoUsage(
          order.customer,
          order.promoCodeId as string,
          okPlan.promoDecrement,
        ),
      );
    }
    await sideEffect("scans_cleanup_failed", () =>
      this.scanModel.deleteMany({ id: { $in: removedTicketIds } }).exec(),
    );
    if (deletesOrder) {
      await sideEffect("cash_scan_events_cleanup_failed", () =>
        this.cashScanEventModel.deleteMany({ orderId }).exec(),
      );
      await sideEffect("telegram_logs_cleanup_failed", () =>
        this.telegramLogModel.deleteMany({ orderId }).exec(),
      );
    }

    await this.updateArchive(archive._id, {
      state: sideEffectErrors.length ? "applied_with_errors" : "applied",
      sideEffectErrors,
      referralStatsDelta,
    });

    this.logger.warn(
      `Tickets ${removedTicketIds.join(",")} of order ${orderId} removed silently (order ${deletesOrder ? "deleted" : "updated"}) by adminId=${adminId} (${adminEmail}); archive=${String(archive._id)}; sideEffectErrors=${sideEffectErrors.join(",") || "none"}`,
    );

    return {
      ok: true,
      removalId: String(archive._id),
      orderId,
      orderAction: deletesOrder ? "deleted" : "updated",
      removedTicketIds,
      sideEffectErrors,
    };
  }

  private async resolveAdminEmail(adminId: string): Promise<string> {
    try {
      const admin = await this.adminsService.findByIdPublic(adminId);
      return admin?.email ?? adminId;
    } catch {
      return adminId;
    }
  }
}
