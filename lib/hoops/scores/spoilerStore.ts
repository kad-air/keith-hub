// The per-device record of which of today's games the viewer has revealed or
// synced (components/hoops/scores/LiveProvider.tsx reads and writes it).
// localStorage, keyed by date, so a reveal survives a reload and yesterday's
// choices never leak into today — every other date's key is pruned on save.
// Every access is wrapped: storage can be absent, full or blocked (private
// mode, cleared site data), and the page must simply behave as if nothing
// had been revealed.

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
      if (k && k.startsWith(PREFIX) && k !== PREFIX + date) ls.removeItem(k);
    }
    if (Object.keys(map).length === 0) ls.removeItem(PREFIX + date);
    else ls.setItem(PREFIX + date, JSON.stringify(map));
  } catch {
    /* storage unavailable — the choice lives for this page only */
  }
}
