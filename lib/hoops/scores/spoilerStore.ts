// The per-device record of which of today's games the viewer has revealed or
// synced (components/hoops/scores/LiveProvider.tsx reads and writes it).
// localStorage, keyed by date, so a reveal survives a reload and yesterday's
// choices never leak into today. On save every key older than the day before
// the saved date is pruned: yesterday's is kept so last night's games keep
// their veil or sync until 3 AM (dates.ts isGuardedDate) and a game still
// synced from last night stays on today's page past noon (keepLastNight
// below); saving yesterday's map never touches today's.
// Every access is wrapped: storage can be absent, full or blocked (private
// mode, cleared site data), and the page must simply behave as if nothing
// had been revealed.

import { addDays, isIsoDate } from "./dates.ts";
import type { SpoilerEntry } from "./types.ts";

const PREFIX = "hoops-spoiler:";

export type SpoilerMap = Record<string, SpoilerEntry>;

export function loadSpoiler(date: string): SpoilerMap {
  try {
    const raw = window.localStorage.getItem(PREFIX + date);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: SpoilerMap = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      const e = v as Partial<SpoilerEntry> | null;
      if (e?.mode === "revealed") out[id] = { mode: "revealed" };
      else if (e?.mode === "synced" && typeof e.offsetMs === "number" && e.offsetMs >= 0) {
        out[id] = { mode: "synced", offsetMs: e.offsetMs };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function saveSpoiler(date: string, map: SpoilerMap): void {
  try {
    const ls = window.localStorage;
    for (let i = ls.length - 1; i >= 0; i--) {
      const k = ls.key(i);
      if (k && staleSpoilerKey(k, date)) ls.removeItem(k);
    }
    if (Object.keys(map).length === 0) ls.removeItem(PREFIX + date);
    else ls.setItem(PREFIX + date, JSON.stringify(map));
  } catch {
    /* storage unavailable — the choice lives for this page only */
  }
}

/** A stored key saving `date` drops: any date's older than the day before
 *  (a later date's — today's, when last night's map is saved — stays). */
export function staleSpoilerKey(key: string, date: string): boolean {
  if (!key.startsWith(PREFIX)) return false;
  const d = key.slice(PREFIX.length);
  return !isIsoDate(d) || d < addDays(date, -1);
}

/** Which of last night's games today's page still lists. Before the noon
 *  cutoff, all of them; after it, only those the viewer synced last night
 *  and hasn't watched to the final (a synced game that reaches the final is
 *  promoted to revealed, which lets it go). */
export function keepLastNight(ids: string[], lastNight: SpoilerMap, pastCutoff: boolean): string[] {
  if (!pastCutoff) return ids;
  return ids.filter((id) => lastNight[id]?.mode === "synced");
}
