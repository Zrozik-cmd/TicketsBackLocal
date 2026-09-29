import type {
  IMockOrder,
  IMockOrderTicket,
} from "../../mock-orders/schemas/mock-order.schema";
import type { ITicket } from "../../tickets/schemas/ticket.schema";
import { roundMoney } from "../../mock-orders/utils/mock-order-refund.util";
import type { TicketRemovalOrderMoney } from "../types/admin-vault.types";

export type TicketRemovalPlanOrder = Pick<
  IMockOrder,
  | "tickets"
  | "price"
  | "vat"
  | "additionalTicketCostFee"
  | "total_price"
  | "bankCardFee"
  | "cashFee"
  | "originalPaidAmount"
  | "promocodeDiscount"
  | "promoCodeId"
  | "promoTicketCount"
>;

export type TicketRemovalPlanTicket = Pick<
  ITicket,
  "id" | "sector" | "zone" | "session" | "price"
>;

export type TicketRemovalPlan =
  | { ok: false; blocker: "order_line_mismatch"; ticketId: number }
  | {
      ok: true;
      action: "update" | "delete";
      /** Share of the order that stays (money-weighted; by ticket count for a free order). */
      factor: number;
      countBefore: number;
      countAfter: number;
      removedCount: number;
      /** `$set` for the order; null when the whole order goes. */
      after: Record<string, unknown> | null;
      /** How much to take off the promo usage counters (0 — nothing). */
      promoDecrement: number;
    };

/** Money fields scaled only when the order carries them (older orders lack some). */
const OPTIONAL_MONEY_FIELDS = [
  "bankCardFee",
  "cashFee",
  "originalPaidAmount",
  "promocodeDiscount",
] as const;

function lineCount(lines: Array<Pick<IMockOrderTicket, "count">>): number {
  return lines.reduce((sum, line) => sum + (line.count ?? 0), 0);
}

function lineAmount(
  lines: Array<Pick<IMockOrderTicket, "count" | "price">>,
): number {
  return lines.reduce(
    (sum, line) => sum + (line.price ?? 0) * (line.count ?? 0),
    0,
  );
}

/**
 * Pure plan of a silent ticket removal: which order lines lose a ticket and what the
 * order totals become. Every money field is scaled by the same factor, so the order
 * looks as if it had been bought without the removed tickets.
 */
export function planTicketRemoval(
  order: TicketRemovalPlanOrder,
  tickets: TicketRemovalPlanTicket[],
): TicketRemovalPlan {
  const originalLines = (order.tickets ?? []).map((line) => ({ ...line }));
  const lines = originalLines.map((line) => ({ ...line }));

  const sorted = [...tickets].sort((a, b) => a.id - b.id);
  for (const ticket of sorted) {
    const line = lines.find(
      (l) =>
        l.count > 0 &&
        l.sectorId === ticket.sector &&
        l.zoneId === ticket.zone &&
        (l.session ?? null) === (ticket.session ?? null) &&
        roundMoney(l.price) === roundMoney(ticket.price),
    );
    if (!line) {
      return { ok: false, blocker: "order_line_mismatch", ticketId: ticket.id };
    }
    line.count -= 1;
  }

  const remaining = lines.filter((line) => line.count > 0);
  const countBefore = lineCount(originalLines);
  const countAfter = lineCount(remaining);
  const removedCount = sorted.length;
  const amountBefore = lineAmount(originalLines);
  const amountAfter = lineAmount(remaining);
  const factor =
    amountBefore > 0
      ? amountAfter / amountBefore
      : countBefore > 0
        ? countAfter / countBefore
        : 0;

  const hasPromo =
    !!order.promoCodeId && typeof order.promoTicketCount === "number";

  if (countAfter === 0) {
    return {
      ok: true,
      action: "delete",
      factor: 0,
      countBefore,
      countAfter,
      removedCount,
      after: null,
      promoDecrement: hasPromo ? (order.promoTicketCount as number) : 0,
    };
  }

  const after: Record<string, unknown> = {
    tickets: remaining,
    price: roundMoney((order.price ?? 0) * factor),
    vat: roundMoney((order.vat ?? 0) * factor),
    additionalTicketCostFee: roundMoney(
      (order.additionalTicketCostFee ?? 0) * factor,
    ),
    total_price: roundMoney((order.total_price ?? 0) * factor),
  };
  for (const field of OPTIONAL_MONEY_FIELDS) {
    const value = order[field];
    if (typeof value === "number") {
      after[field] = roundMoney(value * factor);
    }
  }
  let promoDecrement = 0;
  if (typeof order.promoTicketCount === "number") {
    const promoTicketCount = Math.max(
      1,
      order.promoTicketCount - removedCount,
    );
    after.promoTicketCount = promoTicketCount;
    if (hasPromo) {
      promoDecrement = order.promoTicketCount - promoTicketCount;
    }
  }

  return {
    ok: true,
    action: "update",
    factor,
    countBefore,
    countAfter,
    removedCount,
    after,
    promoDecrement,
  };
}

/** Order money as the preview shows it; optional fields the order lacks are null. */
export function ticketRemovalOrderMoney(
  order: Partial<
    Pick<
      IMockOrder,
      | "price"
      | "vat"
      | "additionalTicketCostFee"
      | "total_price"
      | "bankCardFee"
      | "cashFee"
      | "originalPaidAmount"
      | "promocodeDiscount"
    >
  >,
  ticketCount: number,
): TicketRemovalOrderMoney {
  const optional = (value: unknown): number | null =>
    typeof value === "number" ? value : null;
  return {
    ticketCount,
    price: order.price ?? 0,
    vat: order.vat ?? 0,
    additionalTicketCostFee: order.additionalTicketCostFee ?? 0,
    bankCardFee: optional(order.bankCardFee),
    cashFee: optional(order.cashFee),
    totalPrice: order.total_price ?? 0,
    originalPaidAmount: optional(order.originalPaidAmount),
    promocodeDiscount: optional(order.promocodeDiscount),
  };
}
