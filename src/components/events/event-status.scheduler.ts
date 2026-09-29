import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import mongoose from "mongoose";
import { EventSchema, IEvent, IEventDate } from "./schemas/event.schema";
import { IndexNowService } from "../../services/indexnow/indexnow.service";
import { EventMessengersNotifierService } from "../event-messengers/services/event-messengers-notifier.service";
import { SALES_REASON } from "../event-messengers/constants/event-messengers.constants";

/**
 * Sets stored status to COMPLETED for ACTIVE events whose last calendar day
 * (UTC) is before today. Runs daily at midnight (server time).
 */
@Injectable()
export class EventStatusScheduler {
  private readonly logger = new Logger(EventStatusScheduler.name);

  constructor(
    private readonly indexNowService: IndexNowService,
    private readonly messengersNotifier: EventMessengersNotifierService,
  ) {}

  private get eventModel(): mongoose.Model<IEvent> {
    return (
      (mongoose.models.Event as mongoose.Model<IEvent>) ??
      mongoose.model<IEvent>("Event", EventSchema)
    );
  }

  private normalizeYmd(raw: string): string | null {
    const s = raw.trim().slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  }

  private todayYmdUtc(): string {
    const d = new Date();
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  /** Last calendar day of the event is strictly before today (UTC). */
  private isEventDateFinished(eventDate: IEventDate): boolean {
    const start = this.normalizeYmd(eventDate.startDate);
    const last =
      eventDate.isRange && eventDate.endDate?.trim()
        ? this.normalizeYmd(eventDate.endDate)
        : start;
    if (!last) {
      return false;
    }
    return this.todayYmdUtc() > last;
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async markPastActiveEventsCompleted(): Promise<void> {
    const todayYmd = this.todayYmdUtc();
    const docs = await this.eventModel
      .find({ status: "ACTIVE" })
      .select({ id: 1, eventDate: 1, title: 1 })
      .lean()
      .exec();

    const ops: Array<{
      updateOne: {
        filter: { id: number };
        update: { $set: { status: "COMPLETED" } };
      };
    }> = [];
    const completedPaths: string[] = [];
    for (const doc of docs as Array<Pick<IEvent, "id" | "eventDate" | "title">>) {
      if (this.isEventDateFinished(doc.eventDate)) {
        ops.push({
          updateOne: {
            filter: { id: doc.id },
            update: { $set: { status: "COMPLETED" } },
          },
        });
        completedPaths.push(
          this.indexNowService.eventPath(doc.id, doc.title?.en),
        );
      }
    }

    if (ops.length === 0) {
      this.logger.log(
        `event completion cron (${todayYmd}): no ACTIVE events to complete`,
      );
      return;
    }

    await this.eventModel.bulkWrite(ops);
    this.logger.log(
      `event completion cron (${todayYmd}): marked ${ops.length} ACTIVE event(s) as COMPLETED`,
    );
    // Tell IndexNow the pages changed state (purchase card → archive plate)
    // and the listings no longer include them.
    this.indexNowService.notifyPaths([
      ...completedPaths,
      "/events",
      "/events/archive",
    ]);
    // Event group chats (LINE): sales closed by completion, one event at a time.
    const completedIds = ops.map((op) => op.updateOne.filter.id);
    void (async () => {
      for (const eventId of completedIds) {
        await this.messengersNotifier
          .recheckSales(eventId, SALES_REASON.EVENT_COMPLETED)
          .catch((err) => {
            this.logger.warn(
              `Messenger sales recheck failed for event ${eventId}: ${(err as Error)?.message}`,
            );
          });
      }
    })();
  }
}
