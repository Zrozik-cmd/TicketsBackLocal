/**
 * Statistics / ticket-registry filter by show date and/or one session.
 *
 * `from`/`to` are inclusive ICT days (`YYYY-MM-DD`) compared with the SESSION date of a
 * ticket or order line — never with the purchase date. A line without a session (a
 * one-off event) is dated by the event's `eventDate.startDate`. Pure apart from the 400
 * it raises, so the matching rules can be exercised from a plain script.
 */
import { BadRequestException } from '@nestjs/common';
import type { EventSessionStatus } from '../../event-sessions/schemas/event-session.schema';

export const ICT_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type SessionPeriodFilter = {
  from?: string;
  to?: string;
  sessionId?: number;
};

/**
 * Which shows a period covers, resolved once per request and handed to every query.
 * `sessionIds` lists sessions of every status (`cancelled` and `disabled` ones sold real
 * tickets); `sessionlessMatch` says whether session-less lines fall inside the period.
 */
export type SessionPeriodScope = {
  sessions: Array<{ id: number; date: string; start: string; end: string; status: EventSessionStatus }>;
  sessionIds: number[];
  sessionlessMatch: boolean;
};

/**
 * `null` when no filter param is present — the caller then keeps its unfiltered output
 * byte for byte. Throws 400 `invalid_date_range` when `from` is after `to`.
 */
export function normalizeSessionPeriodFilter(
  input?: SessionPeriodFilter | null,
): SessionPeriodFilter | null {
  const from = typeof input?.from === 'string' && input.from.trim() ? input.from.trim() : undefined;
  const to = typeof input?.to === 'string' && input.to.trim() ? input.to.trim() : undefined;
  const sessionId =
    typeof input?.sessionId === 'number' && Number.isInteger(input.sessionId)
      ? input.sessionId
      : undefined;
  if (from === undefined && to === undefined && sessionId === undefined) return null;
  if ((from && !ICT_DAY_PATTERN.test(from)) || (to && !ICT_DAY_PATTERN.test(to))) {
    throw new BadRequestException('invalid_date_range');
  }
  if (from && to && from > to) {
    throw new BadRequestException('invalid_date_range');
  }
  return {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}

/** Inclusive day-string range check; a missing/malformed day never matches. */
export function isDayInPeriod(
  day: string | null | undefined,
  filter: Pick<SessionPeriodFilter, 'from' | 'to'>,
): boolean {
  if (typeof day !== 'string' || !ICT_DAY_PATTERN.test(day)) return false;
  if (filter.from && day < filter.from) return false;
  if (filter.to && day > filter.to) return false;
  return true;
}

/**
 * Session-less lines (one-off events) match when the event's own date lies in the
 * period. A `sessionId` filter names one show, so it never matches them.
 */
export function sessionlessLinesMatch(
  eventStartDate: string | null | undefined,
  filter: SessionPeriodFilter,
): boolean {
  if (filter.sessionId !== undefined) return false;
  return isDayInPeriod(eventStartDate, filter);
}

/** True when nothing at all can match — callers skip their queries. */
export function isEmptyPeriodScope(scope: SessionPeriodScope): boolean {
  return !scope.sessionIds.length && !scope.sessionlessMatch;
}

/** A Mongo condition no document satisfies (an empty period); fresh per call, casts may mutate it. */
const matchNothing = (): Record<string, unknown> => ({ _id: { $in: [] } });

/**
 * Mongo condition on a document holding an array of lines (`tickets` on an order,
 * `refundedTickets` on a refunded one): at least one line of the period.
 */
export function periodLinesQuery(
  scope: SessionPeriodScope,
  arrayPath: string,
): Record<string, unknown> {
  const branches: Array<Record<string, unknown>> = [];
  if (scope.sessionIds.length) {
    branches.push({ [`${arrayPath}.session`]: { $in: scope.sessionIds } });
  }
  if (scope.sessionlessMatch) {
    // `session: null` inside $elemMatch also matches a line with no `session` key.
    branches.push({ [arrayPath]: { $elemMatch: { session: null } } });
  }
  if (!branches.length) return matchNothing();
  return branches.length === 1 ? branches[0] : { $or: branches };
}

/** Mongo condition on a flat ticket-like document (`session` at `sessionPath`). */
export function periodTicketQuery(
  scope: SessionPeriodScope,
  sessionPath = 'session',
): Record<string, unknown> {
  const branches: Array<Record<string, unknown>> = [];
  if (scope.sessionIds.length) {
    branches.push({ [sessionPath]: { $in: scope.sessionIds } });
  }
  if (scope.sessionlessMatch) {
    branches.push({ [sessionPath]: null });
  }
  if (!branches.length) return matchNothing();
  return branches.length === 1 ? branches[0] : { $or: branches };
}

/**
 * Aggregation expression: does the order line bound to `$$<lineVar>` belong to the
 * period? Same rule as `periodLinesQuery`, evaluated per line.
 */
export function periodLineMatchExpr(
  scope: SessionPeriodScope,
  lineVar: string,
): Record<string, unknown> | boolean {
  const session = `$$${lineVar}.session`;
  const branches: Array<Record<string, unknown>> = [];
  if (scope.sessionIds.length) {
    branches.push({ $in: [{ $ifNull: [session, null] }, scope.sessionIds] });
  }
  if (scope.sessionlessMatch) {
    branches.push({ $not: [{ $isNumber: session }] });
  }
  if (!branches.length) return false;
  return branches.length === 1 ? branches[0] : { $or: branches };
}

/**
 * Aggregation expression for an order's share of the period, `0..1`:
 * `sum(price*count of matching lines) / sum(price*count of all lines)`, falling back to
 * the count ratio when every line is free (a 100% promo order still has a VAT of 0 and
 * money fields of 0, but its seats count).
 */
export function periodShareExpr(
  scope: SessionPeriodScope,
  linesPath = '$tickets',
): Record<string, unknown> {
  const lineVar = 'line';
  const matches = periodLineMatchExpr(scope, lineVar);
  const lineAmount = {
    $multiply: [{ $ifNull: [`$$${lineVar}.price`, 0] }, { $ifNull: [`$$${lineVar}.count`, 0] }],
  };
  const lineCount = { $ifNull: [`$$${lineVar}.count`, 0] };
  // `$$value` is the running sum, `$$line` the current order line.
  const sumOver = (value: unknown, onlyMatching: boolean) => ({
    $reduce: {
      input: { $ifNull: [linesPath, []] },
      initialValue: 0,
      in: {
        $let: {
          vars: { [lineVar]: '$$this' },
          in: { $add: ['$$value', onlyMatching ? { $cond: [matches, value, 0] } : value] },
        },
      },
    },
  });
  return {
    $let: {
      vars: {
        matchedAmount: sumOver(lineAmount, true),
        totalAmount: sumOver(lineAmount, false),
        matchedCount: sumOver(lineCount, true),
        totalCount: sumOver(lineCount, false),
      },
      in: {
        $cond: [
          { $gt: ['$$totalAmount', 0] },
          { $divide: ['$$matchedAmount', '$$totalAmount'] },
          {
            $cond: [
              { $gt: ['$$totalCount', 0] },
              { $divide: ['$$matchedCount', '$$totalCount'] },
              0,
            ],
          },
        ],
      },
    },
  };
}
