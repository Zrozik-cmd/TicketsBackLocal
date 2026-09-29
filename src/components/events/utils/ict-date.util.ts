/**
 * Thailand wall-clock helpers.
 *
 * Sessions, event dates and show times are stored as plain local strings
 * (`YYYY-MM-DD`, `HH:MM`) in ICT (UTC+7, no DST). Every "what day is it now"
 * comparison against those strings must therefore be made in ICT — a UTC
 * calendar day is 7 hours behind and, between 00:00 and 07:00 Bangkok time,
 * still reads as *yesterday*, which is exactly the window in which a UTC-based
 * check lets already-finished sessions through as bookable.
 */
export const ICT_OFFSET_MS = 7 * 60 * 60 * 1000;

/** Today's date in ICT, `YYYY-MM-DD`. */
export function todayIct(now: number = Date.now()): string {
  return new Date(now + ICT_OFFSET_MS).toISOString().slice(0, 10);
}

/** Current wall-clock time in ICT, `HH:MM`. */
export function nowIctClock(now: number = Date.now()): string {
  return new Date(now + ICT_OFFSET_MS).toISOString().slice(11, 16);
}
