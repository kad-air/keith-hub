// Pure date helpers for the scores section. All calendar maths is STRING
// maths on YYYY-MM-DD (via Date.UTC, never local time), and the only clock
// that matters is the reader's: the VIEWER's time zone (owner, 2026-11-05 —
// "I travel"). The device reports it (components/hoops/scores/ViewerTz.tsx
// sets the TZ_COOKIE, lib/hoops/scores/viewerTz.ts reads it on the server);
// until it has, and for anything that isn't a viewer, it is America/Denver.
// Railway runs UTC, so a 9pm Mountain tip is already "tomorrow" on the
// server — the same trap lib/books/stats.ts documents for reading streaks.
//
// The upstream lists games under their US EASTERN date (the slate). For an
// NBA game that is the same day as Mountain time (tips run ~10am–10:30pm
// ET), so the date in the URL and ESPN's `dates=` parameter are used
// interchangeably. "Today" is the viewer's calendar date; a viewer far east
// of the US (Europe, Asia) watches a slate after their own midnight, so the
// spoiler cutoffs below never fall before 3 AM Eastern (see spoilerUntil).

/** The fallback zone: the owner's home, used before the device has said. */
export const SCORES_TZ = "America/Denver";

/** The slate's own zone: ESPN dates games by the US Eastern calendar. */
export const SLATE_TZ = "America/New_York";

/** The cookie the client writes its IANA zone into (ViewerTz.tsx). */
export const TZ_COOKIE = "hub-tz";

/** A usable IANA zone name, or null. Anything the runtime can't format in
 *  (garbage, a stale or unknown zone) is refused, so a bad cookie falls back
 *  to Mountain instead of throwing a RangeError mid-render. */
export function normalizeTz(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 64 || !/^[A-Za-z0-9_+\-]+(\/[A-Za-z0-9_+\-]+)*$/.test(raw)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: raw }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** The zone's short label at `at`: "MT", "ET", "PT", "HST" where there's a
 *  short US-style name, else the offset form ("GMT", "GMT+9"). */
export function tzLabel(tz: string = SCORES_TZ, at: Date = new Date()): string {
  const name = (style: "shortGeneric" | "short") =>
    new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: style })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value ?? "";
  const generic = name("shortGeneric");
  return generic && generic.length <= 4 && !generic.includes(" ") ? generic : name("short");
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date in YYYY-MM-DD (rejects 2026-02-30). */
export function isIsoDate(s: string): boolean {
  const m = ISO.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** Today's date in `tz` (Denver by default), for the instant `now`. */
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

/** Tip time in `tz`: "7:30 PM". */
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

/** The epoch ms at which the wall clock in `tz` reads `hour`:00 on `iso`.
 *  Found by correcting a UTC guess by the zone's offset at that guess, twice
 *  so a DST change between the guess and the answer settles. */
export function wallClockAt(iso: string, hour: number, tz: string = SCORES_TZ): number {
  const [y, m, d] = iso.split("-").map(Number);
  const want = Date.UTC(y, m - 1, d, hour);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  });
  const wall = (t: number): number => {
    const p: Record<string, number> = {};
    for (const part of fmt.formatToParts(new Date(t))) p[part.type] = Number(part.value);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  };
  let t = want;
  for (let i = 0; i < 2; i++) t += want - wall(t);
  return t;
}

/** Today's page carries last night's games until noon (the viewer's), then
 *  lets them go (a game the viewer is still synced to stays —
 *  spoilerStore.ts). */
export const LAST_NIGHT_UNTIL_HOUR = 12;

/** The instant `today`'s page stops showing last night's games: noon in
 *  `tz`, but never before last night's spoiler mode ends — in Tokyo last
 *  night's slate is still being played at noon. */
export function lastNightUntil(today: string, tz: string = SCORES_TZ): number {
  return Math.max(wallClockAt(today, LAST_NIGHT_UNTIL_HOUR, tz), spoilerUntil(today, tz));
}

/** Spoiler mode outlives its day by a few hours: a game the viewer left
 *  veiled or synced stays that way past midnight, until 3 AM on the next
 *  day, and then the scores just show (owner, 2026-10-28). */
export const SPOILER_UNTIL_HOUR = 3;

/** The instant `today`'s page stops guarding last night's games: 3 AM in
 *  `tz`, or 3 AM Eastern if that is later. The floor is what keeps the
 *  guarantee for a viewer east of the US: the slate is Eastern-dated and its
 *  last games end around 1:30 AM Eastern, so in London (3 AM there is 10 PM
 *  Eastern) or Tokyo last night's games are still live at 3 AM local. For
 *  every US zone the viewer's own 3 AM is the later one, so the rule there
 *  is just "3 AM where you are" — Mountain is exactly as before. */
export function spoilerUntil(today: string, tz: string = SCORES_TZ): number {
  return Math.max(wallClockAt(today, SPOILER_UNTIL_HOUR, tz), wallClockAt(today, SPOILER_UNTIL_HOUR, SLATE_TZ));
}

/** Whether `date`'s started games are under spoiler mode at `now`: today's
 *  always, yesterday's until 3 AM. The one rule the pages and the live
 *  endpoint share, so the server never ships what the page would veil. */
export function isGuardedDate(date: string, now: Date, tz: string = SCORES_TZ): boolean {
  const today = todayIn(now, tz);
  if (date === today) return true;
  return date === addDays(today, -1) && now.getTime() < spoilerUntil(today, tz);
}
