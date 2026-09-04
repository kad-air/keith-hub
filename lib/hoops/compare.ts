// Two players' rating ledgers, side by side — the pure half.
//
// No fs, no SQLite, no JSX: everything here is arithmetic and wording over the
// bundle's own explain blocks, so scripts/check-hoops-explain.ts can drive it
// directly and the build gate re-adds the ledger on every push.
//
// ───────────────────────────────────────────────────────────────────────────
// 🔴 WHY THE "BIGGEST REASON" IS NOT SIMPLY THE BIGGEST GAP IN THE TABLE.
//
// The ledger the player page prints is a story, not a sum of independent
// parts: "what his box score earns" and "what happened with him on the floor"
// are the two halves that get MIXED, "mixed" is a function of both, "the
// scouting report" is that plus aging, and "his rating" is the report plus the
// tape. Six of those eleven rows contain each other. Picking the row where two
// players differ most, over that list, would count one difference three times
// and call it three reasons.
//
// So the reason is chosen over the ADDITIVE terms of the rating — the four
// quantities that add, per side, to exactly the number on the last row:
//
//     final = w·history + (1−w)·box + aging + tape move
//
// (or, when the block carries no box/history halves to split, the coarser
//  final = scouting report + tape move, which every block supports).
//
// `additiveTerms` returns those, `compareVerdict` pairs them and takes the
// largest gap, and the check asserts both halves: that the terms sum to the
// shipped rating on every carrier in the bundle, and that the reason the
// sentence names really is the biggest of them.
// ───────────────────────────────────────────────────────────────────────────

import { toReplacementScale } from "./playervalue.ts";
import type { ReplacementLevels } from "./playervalue.ts";
import { fmtSigned } from "./rating.ts";
import type { ExplainModel, OffDef, RawPlayerExplain } from "./types.ts";

export type Side = "off" | "def";

// ───────────────────────────────────────────────────────────────────────────
// REPLACEMENT-ZERO, round 2 (issue #70 F5, owner decision 2026-09-04: "one
// scale on every player surface" — the owner saw the player page's ledger
// print "+4.98 minus replacement −1.18 = +6.16" and, correctly, called it
// still average-zero with a conversion bolted on).
//
// `shiftExplainToReplacement` builds a COPY of a player's explain block with
// every LEVEL quantity shifted onto the replacement scale, so a
// replacement-level player's own numbers read exactly 0.00. Once built, it
// is just a `RawPlayerExplain` — every existing function below
// (`ledgerLines`, `additiveTerms`, `compareVerdict`, `verdictSentence`,
// `netOfExplain`) keeps working on it completely UNCHANGED, because none of
// them do anything but read `RawPlayerExplain`'s own fields. That is what
// makes this ONE shift apply consistently everywhere the ledger appears
// (the player page, the compare page's table AND its verdict sentence)
// without a second implementation anywhere.
//
// Which rows are levels and which are deltas, and why the sum still holds:
// `mixed = w·history + (1−w)·box`. Shifting `history` and `box` by the SAME
// constant R (their own side's replacement level) shifts `mixed` by exactly
// R too, because `w + (1−w) == 1` — a weighted AVERAGE of two equally-shifted
// numbers shifts by that same amount, regardless of the weight. `report (mu)
// = mixed + aging`; aging is a genuine DELTA (what a year older costs him)
// and must NOT be shifted, so adding it to a now-R-shifted mixed keeps the
// report shifted by exactly R. Same story one row further: `final = report +
// tape move`, tape move is a delta too, so final ends up shifted by R as
// well. The chain never breaks, on any side, regardless of prior_kind.
export function shiftExplainToReplacement(
  e: RawPlayerExplain,
  levels: ReplacementLevels | null,
): RawPlayerExplain {
  if (!levels) return e;
  const shift = (v: OffDef): OffDef => ({
    off: toReplacementScale("off", v.off, levels),
    def: toReplacementScale("def", v.def, levels),
  });
  return {
    ...e,
    mu: shift(e.mu),
    box: e.box
      ? {
          ...e.box,
          ...shift(e.box),
          baseline_off: toReplacementScale("off", e.box.baseline_off, levels),
          baseline_def: toReplacementScale("def", e.box.baseline_def, levels),
          // items (rate/league/coef/contrib) are UNTOUCHED — contrib is a
          // delta (a stat's contribution above or below league average), and
          // the baseline shift above already carries the level.
        }
      : null,
    history: e.history ? { ...e.history, ...shift(e.history) } : null,
    final: shift(e.final),
    // aging, tape, weights, prior_kind, prior_floored, replacement_per36:
    // UNCHANGED. aging/tape are deltas; the rest are not per-36 levels at all.
  };
}

/** "2018" → "2018-19". Shared with the player page's ledger. */
export function seasonLabel(startYear: number): string {
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

/** A weight as a whole percent, the way the ledger says it out loud. */
export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

// ---------------------------------------------------------------------------
// The ledger, as data
// ---------------------------------------------------------------------------

export type LedgerKey =
  | "resume"
  | "rookie"
  | "no-prior"
  | "box"
  | "history"
  | "mixed"
  | "aging"
  | "scouting"
  | "floored"
  | "tape"
  | "rating";

export interface LedgerLine {
  key: LedgerKey;
  label: string;
  sub?: string;
  off: number | null;
  def: number | null;
  /** A leading operator glyph, so the column reads as a sum. */
  op?: string;
  emphasis?: "result" | "muted";
}

/** Short labels for the two-player table, where the page-length wording of
 *  `ledgerLines` will not fit beside four columns of numbers on a phone. */
export const LEDGER_SHORT: Record<LedgerKey, string> = {
  resume: "Résumé",
  rookie: "Draft night",
  "no-prior": "No report",
  box: "Box earns",
  history: "History said",
  mixed: "Mixed",
  aging: "A year older",
  scouting: "Scouting report",
  floored: "Report set aside",
  tape: "Tape moved him",
  rating: "Rating",
};

/** The canonical order the ledger reads in, top to bottom. */
export const LEDGER_ORDER: LedgerKey[] = [
  "resume",
  "rookie",
  "no-prior",
  "box",
  "history",
  "mixed",
  "aging",
  "scouting",
  "floored",
  "tape",
  "rating",
];

/**
 * The player page's ledger, as rows rather than markup — one source of truth
 * for the wording, shared by the single-player page and the comparison.
 */
export function ledgerLines(e: RawPlayerExplain, model: ExplainModel | null): LedgerLine[] {
  const lam = model?.lam ?? null;
  const n = Math.min(e.tape.n_off_poss, e.tape.n_def_poss);
  const ownShare = lam != null && n + lam > 0 ? n / (n + lam) : null;
  const mixed: OffDef | null =
    e.prior_kind === "box+history" && e.history && e.box && e.weights
      ? {
          off: e.weights.off * e.history.off + (1 - e.weights.off) * e.box.off,
          def: e.weights.def * e.history.def + (1 - e.weights.def) * e.box.def,
        }
      : null;

  const out: LedgerLine[] = [];
  if (e.prior_kind === "resume") {
    out.push({
      key: "resume",
      label: "His résumé",
      sub: "no possessions on the tape yet — priced from box score and history alone",
      off: e.mu.off,
      def: e.mu.def,
    });
  }
  if (e.prior_kind === "rookie") {
    out.push({
      key: "rookie",
      label: "Draft night",
      sub: "no NBA line yet: priced from draft slot, college box, age and size",
      off: e.mu.off,
      def: e.mu.def,
    });
  }
  if (e.prior_kind === "none") {
    // 🔴 Reads e.mu, never a hardcoded 0 — the model sets him to league
    // average internally either way, but once `e` has been through
    // shiftExplainToReplacement, "league average" is no longer 0.00: it is
    // whatever a league-average player is worth above replacement (a real,
    // positive number, since a replacement player is BELOW average). A
    // literal 0 here would silently stop being true the moment the caller
    // shifts.
    out.push({
      key: "no-prior",
      label: "No scouting report",
      sub: "nothing to price him from before the tape — he starts at league average",
      off: e.mu.off,
      def: e.mu.def,
      emphasis: "muted",
    });
  }
  if (e.box) {
    out.push({
      key: "box",
      label: "What his box score earns",
      sub:
        e.box.minutes != null
          ? `the wage sheet on ${Math.round(e.box.minutes).toLocaleString()} minutes of his line`
          : "the wage sheet on his line",
      off: e.box.off,
      def: e.box.def,
    });
  }
  if (e.history) {
    out.push({
      key: "history",
      label: "What happened with him on the floor",
      sub: `his plus-minus history through ${seasonLabel(e.history.ref_season)}, before the tape window`,
      off: e.history.off,
      def: e.history.def,
    });
  }
  if (mixed && e.weights) {
    out.push({
      key: "mixed",
      op: "=",
      label: `Mixed ${pct(e.weights.off)} history, ${pct(1 - e.weights.off)} box score`,
      sub:
        e.weights.def !== e.weights.off
          ? `defence is mixed ${pct(e.weights.def)} / ${pct(1 - e.weights.def)}`
          : undefined,
      off: mixed.off,
      def: mixed.def,
    });
  }
  if (e.aging.off !== 0 || e.aging.def !== 0) {
    out.push({
      key: "aging",
      op: "+",
      label: "A year older",
      sub: "the league's own aging curve, at the strength that predicts real next seasons",
      off: e.aging.off,
      def: e.aging.def,
    });
  }
  if (e.prior_kind !== "none" && !e.prior_floored) {
    out.push({
      key: "scouting",
      op: "=",
      label: "The scouting report",
      sub: "what we would say before watching a possession",
      off: e.mu.off,
      def: e.mu.def,
      emphasis: "result",
    });
  }
  if (e.prior_floored) {
    out.push({
      key: "floored",
      op: "=",
      label: "Scouting report set aside",
      sub: `under ${model?.prior_min_box_minutes?.toFixed(0) ?? "the floor of"} minutes of box evidence, so it is not trusted — he starts at league average instead`,
      off: 0,
      def: 0,
      emphasis: "muted",
    });
  }
  if (e.prior_kind !== "resume") {
    out.push({
      key: "tape",
      op: "+",
      label: "What the tape moved him",
      sub: `${n.toLocaleString()} possessions${
        ownShare != null
          ? ` — about ${pct(ownShare)} his own numbers, ${pct(1 - ownShare)} the report`
          : ""
      }`,
      off: e.tape.move_off,
      def: e.tape.move_def,
    });
  }
  out.push({
    key: "rating",
    op: "=",
    label: "His rating",
    off: e.final.off,
    def: e.final.def,
    emphasis: "result",
  });
  return out;
}

// ---------------------------------------------------------------------------
// The additive decomposition, and the reason
// ---------------------------------------------------------------------------

export type TermKey = "history" | "box" | "aging" | "scouting" | "tape";

export interface CompareTerm {
  key: TermKey;
  side: Side;
  value: number;
}

/** Does this block carry the two halves of a scouting report separately? */
function splitsPrior(e: RawPlayerExplain): boolean {
  return (
    e.prior_kind === "box+history" &&
    !e.prior_floored &&
    e.box != null &&
    e.history != null &&
    e.weights != null
  );
}

export function tapeMove(e: RawPlayerExplain, side: Side): number {
  return side === "off" ? e.tape.move_off : e.tape.move_def;
}

export function tapePossessions(e: RawPlayerExplain, side: Side): number {
  return side === "off" ? e.tape.n_off_poss : e.tape.n_def_poss;
}

/**
 * The terms that ADD, per side, to the rating on the last row of the ledger.
 *
 * `fine === false` forces the coarse split (scouting report + tape) every
 * block supports — what the comparison falls back to when the two players are
 * not priced the same way.
 */
export function additiveTerms(e: RawPlayerExplain, fine = true): CompareTerm[] {
  const out: CompareTerm[] = [];
  const split = fine && splitsPrior(e);
  for (const side of ["off", "def"] as Side[]) {
    if (split && e.history && e.box && e.weights) {
      out.push({ key: "history", side, value: e.weights[side] * e.history[side] });
      out.push({ key: "box", side, value: (1 - e.weights[side]) * e.box[side] });
      if (e.aging[side] !== 0) out.push({ key: "aging", side, value: e.aging[side] });
    } else {
      out.push({ key: "scouting", side, value: e.mu[side] });
    }
    out.push({ key: "tape", side, value: tapeMove(e, side) });
  }
  return out;
}

export interface CompareInput {
  /** The name the sentence uses — the page passes a last name. */
  name: string;
  e: RawPlayerExplain;
  /** Points of margin a game over his expected minutes; null when unpriced. */
  valuePg: number | null;
}

export interface CompareReason {
  key: TermKey;
  side: Side;
  a: number;
  b: number;
  /** a − b, so the sign says who it favours. */
  diff: number;
  favours: "a" | "b";
  /** Possessions behind the two tape moves — only for the tape reason. */
  poss: { a: number; b: number } | null;
}

export interface CompareVerdict {
  leader: "a" | "b";
  /** Whether the lead is stated a game (both priced) or per 36. */
  basis: "game" | "rate";
  /** Rated within a hundredth of a point of each other. */
  level: boolean;
  aNet: number;
  bNet: number;
  rateGap: number;
  gameGap: number | null;
  reason: CompareReason;
  /** True when the reason was chosen on the coarse (scouting report vs tape)
   *  split rather than on the box/history halves. */
  coarse: boolean;
  /** True only when the two men are priced from DIFFERENT ingredients — one
   *  has a plus-minus history to mix in and the other does not. Both being
   *  box-only is not a caveat; the ledger already shows no history row. */
  shapesDiffer: boolean;
}

/** off + def — a player's halves ADD (lib/hoops/playervalue.ts). */
export function netOfExplain(e: RawPlayerExplain): number {
  return e.final.off + e.final.def;
}

export function compareVerdict(a: CompareInput, b: CompareInput): CompareVerdict {
  const aSplits = splitsPrior(a.e);
  const bSplits = splitsPrior(b.e);
  const coarse = !(aSplits && bSplits);
  const at = additiveTerms(a.e, !coarse);
  const bt = additiveTerms(b.e, !coarse);
  const bIndex = new Map(bt.map((t) => [`${t.key}:${t.side}`, t.value]));

  let best: CompareReason | null = null;
  for (const t of at) {
    const other = bIndex.get(`${t.key}:${t.side}`);
    if (other === undefined) continue;
    const diff = t.value - other;
    if (best == null || Math.abs(diff) > Math.abs(best.diff)) {
      best = {
        key: t.key,
        side: t.side,
        a: t.value,
        b: other,
        diff,
        favours: diff >= 0 ? "a" : "b",
        poss:
          t.key === "tape"
            ? { a: tapePossessions(a.e, t.side), b: tapePossessions(b.e, t.side) }
            : null,
      };
    }
  }
  // Every block carries a tape term on both sides, so `best` is never null in
  // practice; the fallback keeps the type honest rather than throwing on a
  // block shape nobody has shipped yet.
  const reason: CompareReason = best ?? {
    key: "tape",
    side: "off",
    a: tapeMove(a.e, "off"),
    b: tapeMove(b.e, "off"),
    diff: tapeMove(a.e, "off") - tapeMove(b.e, "off"),
    favours: "a",
    poss: { a: tapePossessions(a.e, "off"), b: tapePossessions(b.e, "off") },
  };

  const aNet = netOfExplain(a.e);
  const bNet = netOfExplain(b.e);
  const bothPriced = a.valuePg != null && b.valuePg != null;
  const gameGap = bothPriced ? Math.abs((a.valuePg as number) - (b.valuePg as number)) : null;
  const leader: "a" | "b" = bothPriced
    ? (a.valuePg as number) >= (b.valuePg as number)
      ? "a"
      : "b"
    : aNet >= bNet
      ? "a"
      : "b";
  const rateGap = Math.abs(aNet - bNet);
  const level = bothPriced ? (gameGap as number) < 0.005 : rateGap < 0.005;

  return {
    leader,
    basis: bothPriced ? "game" : "rate",
    level,
    aNet,
    bNet,
    rateGap,
    gameGap,
    reason,
    coarse,
    shapesDiffer: aSplits !== bSplits,
  };
}

const SIDE_WORD: Record<Side, string> = { off: "on offence", def: "on defence" };

/**
 * The closing sentence, in basketball words. Every number in it comes off the
 * two explain blocks (or, for the per-game gap, the value the same rows carry)
 * — the check extracts them back out and demands they match.
 */
export function verdictSentence(v: CompareVerdict, aName: string, bName: string): string {
  const lead = v.leader === "a" ? aName : bName;
  const trail = v.leader === "a" ? bName : aName;
  const leadNet = v.leader === "a" ? v.aNet : v.bNet;
  const trailNet = v.leader === "a" ? v.bNet : v.aNet;

  let first: string;
  if (v.level) {
    first = `${aName} and ${bName} are rated level — ${fmtSigned(v.aNet, 2)} against ${fmtSigned(
      v.bNet,
      2,
    )} points per 36 minutes.`;
  } else if (v.gameGap != null) {
    first = `${lead} is worth ${v.gameGap.toFixed(
      2,
    )} points a game more than ${trail} — ${fmtSigned(leadNet, 2)} against ${fmtSigned(
      trailNet,
      2,
    )} points per 36 minutes.`;
  } else {
    first = `${lead} is rated ${v.rateGap.toFixed(
      2,
    )} points per 36 minutes ahead of ${trail} — ${fmtSigned(leadNet, 2)} against ${fmtSigned(
      trailNet,
      2,
    )}.`;
  }

  const r = v.reason;
  const side = SIDE_WORD[r.side];
  const av = fmtSigned(r.a, 2);
  const bv = fmtSigned(r.b, 2);
  let body: string;
  switch (r.key) {
    case "tape":
      body =
        `the tape: ${(r.poss?.a ?? 0).toLocaleString()} possessions moved ${aName} ${av} ${side}, ` +
        `where ${bName}'s ${(r.poss?.b ?? 0).toLocaleString()} moved him ${bv}`;
      break;
    case "box":
      body =
        `what their box scores earn: ${av} ${side} for ${aName} against ${bv} for ${bName}, ` +
        `at the weight the model gives a box line`;
      break;
    case "history":
      body =
        `what happened with them on the floor before the tape window: ${av} ${side} for ${aName} ` +
        `against ${bv} for ${bName}, at the weight the model gives that history`;
      break;
    case "aging":
      body = `the aging curve: ${av} ${side} for ${aName} against ${bv} for ${bName}`;
      break;
    default:
      body =
        `the scouting report they started from: ${av} ${side} for ${aName} against ${bv} for ` +
        `${bName}`;
  }

  // 🔴 The biggest single gap does not have to run the LEADER's way, and
  // saying "the reason he is ahead" when it runs the other way would be a lie
  // the numbers underneath contradict. The terms add to the rating, so when
  // the biggest one favours the man who is behind, the rest of the ledger
  // must more than make it up — say exactly that.
  let second: string;
  if (v.level) {
    second = `The biggest single difference between them is ${body}.`;
  } else if (v.reason.favours === v.leader) {
    second = `The biggest single reason is ${body}.`;
  } else {
    second =
      `The biggest single gap in the ledger actually favours ${trail} — ${body} — so ${lead} is ` +
      `ahead on the rest of it.`;
  }
  return `${first} ${second}`;
}
