// Pure date helpers for the scores section. All calendar maths is STRING
// maths on YYYY-MM-DD (via Date.UTC, never local time), and the only clock
// that matters is the reader's: America/Denver. Railway runs UTC, so a 9pm
// Mountain tip is already "tomorrow" on the server — the same trap
// lib/books/stats.ts documents for reading streaks.
//
// The upstream lists games under their US EASTERN date. For an NBA game that
// is the same day as Mountain time (tips run ~10am–10:30pm ET), so the date
// in the URL and ESPN's `dates=` parameter are used interchangeably.

export const SCORES_TZ = "America/Denver";

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date in YYYY-MM-DD (rejects 2026-02-30). */
export function isIsoDate(s: string): boolean {
  const m = ISO.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** Today's date in Denver, for the instant `now`. */
export function todayIn(now: Date, tz: string = SCORES_TZ): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** "2026-10-21" → "20261021", ESPN's `dates=` form. */
export function espnDate(iso: string): string {
  return iso.replace(/-/g, "");
}

/** Tip time in Mountain: "7:30 PM". */
export function tipTime(utc: string, tz: string = SCORES_TZ): string {
  const t = new Date(utc);
  if (Number.isNaN(t.getTime())) return "TBD";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  }).format(t);
}

/** "2026-10-21" → "Wednesday, October 21, 2026". Noon UTC so no zone can
 *  push it across a day boundary. */
export function longDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

/** "2026-10-21" → "Oct 21". */
export function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}
