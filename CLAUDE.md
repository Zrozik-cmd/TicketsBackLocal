# TicketsBack — rules for AI agents

NestJS + Mongoose backend of Lotus Arena (ticket sales). **Nobody reviews this code by hand and there are no
tests yet**: what you write goes to the dev server as is. You are the only reviewer — a rule skipped here becomes a
silent bug in money, seats or tickets. Read this file fully before changing anything.

## Commands

- Typecheck (must stay at **0 errors**): `node node_modules/typescript/bin/tsc --noEmit --incremental false -p tsconfig.json`
- Never run `nest build` / `npm run build` / `npm run dev` yourself: the owner's `nest start --watch` owns `dist/` and
  restarts on every source change. Keep the tree compiling whenever you stop editing.
- QA scripts and scratch builds go to a scratch folder and a disposable database (`Tickets_<feature>_qa_*`, dropped
  afterwards). Never write test data into the dev database. Never call external services (payments, LINE, Telegram,
  SMTP) from QA — fake them.
- Source files are **CRLF**. Keep each file's line endings; in edit scripts use `s.replace(from, () => to)`.

## 1. Size and structure (no god files)

The biggest threat to this codebase is services that absorb every new feature. Limits:

| Unit | Target | Hard limit |
|---|---|---|
| `*.service.ts` | ≤ 400 lines | 600 |
| any other file | ≤ 300 lines | 500 |
| method / function | ≤ 50 lines | 80 |
| constructor dependencies | ≤ 6 | 8 |

- **New feature = new folder** `src/components/<feature>/` with `<feature>.module.ts`, `controllers/`, `services/`,
  `schemas/`, `dto/`, `utils/`, `constants/`, `types/`. Existing services receive at most a short call into it.
- **One service = one concern.** Split by concern from the start: e.g. `x-query`, `x-write`, `x-statistics`,
  `x-notifier`, `x-cleanup`. Business rules live in **pure functions** in `utils/` (no Nest, no mongoose, time passed in
  as a parameter) so they can be unit-tested.
- **Frozen files** — already far over the limit. They must **not grow**: put new logic in a new service/util next to them
  and call it; if you must edit inside, leave the file the same size or smaller (extract what you touch).
  `events/events.service.ts` (2412), `mock-orders/mock-orders.service.ts` (2112),
  `cash-encashments/cash-encashments.service.ts` (1906), `admin/services/admin-events.service.ts` (1268),
  `event-sessions/event-sessions.service.ts` (1346), `cash-orders/cash-orders.service.ts` (1260),
  `referral-links/referral-links.service.ts` (1201), `content-cms/services/cms-v2.service.ts` (1105),
  `tickets/tickets.service.ts` (864), `promocodes/promocodes.service.ts` (734),
  `admin/services/admin-ticket-removal.service.ts` (725).
- If a task cannot be done without breaking a limit, **say so and propose the split** instead of silently growing a file.
  In your final report list every file you left above its limit.
- **Never copy a business rule.** Before writing one (pricing, "can this be sold", seat counting, status sets, payment
  labels, date math, diffing), grep for the existing implementation and reuse it. When a second caller appears, move
  the rule into a shared util and **delete the private copy** in the same change.

## 2. How this codebase is wired (facts you cannot see from one file)

- No `@nestjs/mongoose`. Models are lazy getters: `mongoose.models.X ?? mongoose.model('X', XSchema)`. Modules isolate
  services, **not data**: `MockOrder` is read from 23 files, `Event` from 21. Before changing the meaning of a field or a
  status, grep `mongoose.models.<Model>` and check every reader.
- Ids are numeric auto-increment (`mongoose-plugin-autoinc`) assigned in a **save hook**: create documents with
  `new Model(...).save()`, not `upsert`/`insertMany`. Collections written by upsert use an explicit natural key instead.
  References are bare numbers (`eventId`, but `event` on MockOrder/Manager; `customer` vs `customerId`) — grep both spellings.
- **No transactions exist.** Make every state change a conditional atomic write
  (`findOneAndUpdate({ id, status: <expected> }, ...)`), add unique indexes / dedup keys for idempotency, and order
  writes so that a crash in the middle is repairable. Webhooks and crons may deliver twice.
- Module graph traps: `EventsModule ↔ ManagersModule ↔ UsersModule` is a cycle held by `forwardRef`. Do not add edges
  into it. A module that hubs must call (Events, MockOrders, Admin, Reviews…) must be a **leaf**: it imports no feature
  module and reads data through model getters (reference: `event-messengers/`). To use `AdminGuard` outside
  `AdminModule`, declare `AdminGuard` + `AdminAuthTokensHelper` as providers in your own module
  (see `cash-encashments/cash-encashments.module.ts`); never import `AdminModule` for a guard.
- Global `ValidationPipe` has `whitelist` + `forbidNonWhitelisted`: every accepted field must be declared in a DTO;
  multipart/query numbers need `@Type(() => Number)`; third-party webhook bodies are typed as plain objects, not DTO classes.
  `create`/`update` of events spread the DTO into `$set` — strip any field that needs processing before the write.
- Errors are Nest exceptions whose message is a stable `snake_case` code; frontends translate codes. Keep codes in a
  `constants/` file of the feature.

## 3. Invariant checklists — "when you touch X, also handle Y"

These rules exist in several hand-maintained copies. Nothing fails if you miss one. Walk the list every time.

**A. An order becomes paid** — two separate paths:
`MockOrdersService.confirmPayment` (online, webhooks, receipt check, 100 % promo, manual confirm) and
`CashOrdersService.finalizeCashOrderAsPaid` (cash confirm + reissue). `admin-mock-orders.service.ts` also sets `'paid'`
when a refund is cancelled — that is **not** a sale.
→ Any new "on sale" side effect goes into **both** paths (or into one shared function both call), or you state in code
why it is channel-specific. Known asymmetry today: Telegram sale alert and referral share run only on the online path —
do not change that without asking. Tickets are created *before* the order is saved as paid and the check is not atomic:
do not add work between those steps; prefer hooks *after* the save, detached (`void x().catch(log)`).

**B. "Can this be sold now?"** — checked in `MockOrdersService.buildOrderPricing`, `CashOrdersService.bookCashOrder`,
cash extend/reissue, and `event-messengers/utils/event-sales-state.util.ts`. Shared predicates: `isSalesClosed`
(`events/constants/event-status.constant.ts`), `isHiddenFromSite` (`events/constants/event-visibility.constant.ts`),
`isEventSalesEnded` / session cut-off (`events/utils/sales-cutoff.util.ts`). A new sales rule must reach every copy.

**C. Seat availability** = `seats − reserved − bought`, where *reserved* = ticket lines of orders in
`['wait','pending_cash']` and *bought* = **every `Ticket` document** of the event/session. Creating or deleting `Ticket`
rows therefore changes availability. `zone.seats` is per event for one-off events and **per session** for recurring ones.
Counter builders: `EventsService.buildZoneCountersForEvents`, `EventSessionsService.buildSessionZoneCounters` (+ its
aggregation twin), `cash-orders.service.ts`. Do not write another one.

**D. Order status sets.** Statuses: `wait, pending_cash, paid, failed, expired, cancelled, refunded`
(`refundStatus: 'refund_in_progress'` keeps `status: 'paid'`). Meanings used in code: *reserved* `wait|pending_cash`;
*holds a seat* `wait|pending_cash|paid`; *sale / revenue* `paid` (refunded orders drop out of every statistic).
Do not add new inline arrays: put a named set in `mock-orders/constants/order-status-sets.constant.ts` (create it if
missing) and use it. Adding or re-meaning a status = audit every file that reads `MockOrder`.

**E. New field on Event** — all of: `IEvent` + schema (`events/schemas/event.schema.ts`); `events/dto/shared.dto.ts`
and `create-event.dto.ts`; `EventsService.withoutPrivateFields` (**deny-list** — a private field leaks to the public site
if you forget); `EVENT_MODERATION_FIELDS` in `events/utils/event-moderation-shape.util.ts` (else it escapes the admin
"changed since approval" diff); the decision in `EventsService.hasSignificantChange` (does it send an ACTIVE event back
to moderation?); admin projection `AdminEventsService.getAdminEventDetailsById` + `admin/types/admin-event.types.ts`;
frontend mirrors (`TicketsFront/lib/api/events.ts`, `canonicalizeForDiff` in the organizer form, `lotus-admin/lib/api/admin-events.ts`).

**F. New collection that references an event (or an order).** Event delete exists twice:
`AdminEventsService.deleteEvent` and `EventRemovalService.deleteWithoutSales` (+ counts in `collectDeletionCounts` /
`admin-vault-events.service.ts`). Register the collection in **both** (pattern: `removeEventMessengerData`). Collections
keyed by order id also belong in `admin/services/admin-ticket-removal.service.ts`.

**G. Admin writes to an Event** must go through `updateEventGuarded`
(`admin/utils/admin-event-guarded-update.util.ts`) and keep the approval snapshot in sync
(`EventApprovalSnapshotsService.syncAdminEdit` / `writeApproval`), otherwise the next moderation diff shows phantom
organizer changes. Sponsors are **admin content**: the organizer DTOs carry neither `sponsors` nor `ticketFormat`, and
`PUT /admin/events/:id/sponsors` (`AdminEventSponsorsService`) writes the approved `sponsors` — what tickets render —
directly. `pendingSponsors` is legacy data only: nothing writes it any more, an admin resolves a leftover list by
approving it or by saving his own.

**H. Money.** `total_price` is always THB = `price + vat + additionalTicketCostFee + (bankCardFee | cashFee)`; the Omise
webhook amount guard, cash ledger, refunds and statistics all depend on that composition. `originalPaidAmount` is the
amount in `paymentCurrency` and may be missing. Round only with `roundMoney`
(`mock-orders/utils/mock-order-refund.util.ts`); no inline `Math.round(x * 100) / 100`. Fee percents come from
`events/utils/event-fee.util.ts`; processing/platform fees are recomputed from the event's *current* percents (known
limitation — do not build new reports that assume they are historical). Pricing is implemented in two checkouts
(mock-orders, cash-orders): change both.

**I. Time.** Business dates are ICT (Asia/Bangkok). Use `events/utils/ict-date.util.ts`; never `new Date()` day math, UTC
days or server-local time for sale windows, sessions, reports.

**J. Background work.** Notifications never break the main flow: `void this.x(...).catch((e) => this.logger.warn(...))`.
Anything that must not be lost gets a delivery/outbox row with a dedup key and a retry cron (reference:
`event-messengers/services/event-messenger-delivery.service.ts`). Crons must tolerate overlap and a second instance.
Boot-time data fixes (`onApplicationBootstrap`) must be idempotent per element, wrapped in try/catch, and awaited after
`mongoose.connection.asPromise()`; prefer a one-off script. Never add writes to read paths.

**K. Security.** Every mutating route has a guard (`AdminGuard`, `UserOrManagerGuard([...])` + ownership check
`event.creator === userId` + `assertManagerAssignedToEvent`, `CustomerGuard`, `CashOrdersAccessGuard`). Third-party
webhooks verify a signature or re-fetch the object from the provider and compare amounts. Known legacy holes —
`POST mock-orders/manual-confirm`, `POST mock-orders/manual-resend-tickets`, `POST mock-orders/webhook` — must not be
copied or extended; tell the owner if your task touches them. Never log tokens, secrets or full webhook keys; never
put secrets into workflow files.

## 4. Before you say "done"

1. Typecheck is 0 errors.
2. You walked checklists A–K for everything you touched and can name which applied.
3. No frozen file grew; no new file exceeds its hard limit; no rule was copy-pasted.
4. New pure logic has a small runnable check (node script or jest spec) and you ran it; flows were exercised against a
   disposable database, not the dev one.
5. Your report states: files created/changed, invariants touched, what you verified and how, what you did **not**
   verify, and any pre-existing problem you noticed (report it, do not fix it unasked).
