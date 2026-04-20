import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { getDb } from "@/lib/db";

// The 14-day curriculum lives in config/practice.yml. Same file-parse pattern
// as lib/config.ts: read once per module load, fall back to the committed
// example if the active config isn't present. No caching — v1 config is small,
// and re-reading the file lets authoring iterations (editing the YAML) show
// up on the next refresh without a server restart.

export type PracticeDay = {
  day: number;
  title: string;
  focus: string;
  lickIds: string[];
  prompt: string;
  why: string;
  backingTrackSearch?: string;
};

export type PracticePreCheck = {
  title: string;
  prompt: string;
  why: string;
};

export type PracticeCurriculum = {
  preCheck: PracticePreCheck;
  days: PracticeDay[];
};

type RawDay = {
  day: number;
  title: string;
  focus: string;
  lick_ids: string[];
  prompt: string;
  why: string;
  backing_track_search?: string;
};

type RawCurriculum = {
  pre_check: { title: string; prompt: string; why: string };
  days: RawDay[];
};

function loadRaw(): RawCurriculum {
  const active = path.join(process.cwd(), "config", "practice.yml");
  const example = path.join(process.cwd(), "config", "practice.example.yml");
  const file = fs.existsSync(active) ? active : example;
  if (!fs.existsSync(file)) {
    throw new Error(
      `Practice curriculum not found. Expected ${active} or ${example}.`,
    );
  }
  const text = fs.readFileSync(file, "utf-8");
  return yaml.load(text) as RawCurriculum;
}

function normalize(raw: RawCurriculum): PracticeCurriculum {
  return {
    preCheck: raw.pre_check,
    days: raw.days.map((d) => ({
      day: d.day,
      title: d.title,
      focus: d.focus.trim(),
      lickIds: d.lick_ids,
      prompt: d.prompt.trim(),
      why: d.why.trim(),
      backingTrackSearch: d.backing_track_search,
    })),
  };
}

export function getCurriculum(): PracticeCurriculum {
  return normalize(loadRaw());
}

export function dayIdFor(day: number): string {
  return `day:${String(day).padStart(2, "0")}`;
}

export type TodayCard =
  | { kind: "next"; day: PracticeDay; doneToday: boolean }
  | { kind: "complete"; totalDays: number };

// Resolve "what the user should see when they open /practice/today":
// - If there's an unlearned day left, return it as "next".
// - If every day has been marked done, return "complete".
// `doneToday` is true if *any* day has been marked done with a done_at
// whose local-time date matches today — used to switch the Today card to a
// "come back tomorrow" state even when the next-undone-day points at a later
// day in the curriculum.
export function resolveToday(
  curriculum: PracticeCurriculum,
  doneDayIds: Set<string>,
): TodayCard {
  const next = curriculum.days.find(
    (d) => !doneDayIds.has(dayIdFor(d.day).slice(4)),
  );
  if (!next) return { kind: "complete", totalDays: curriculum.days.length };
  // doneToday derived at call site in the server component where we have DB
  // access to done_at timestamps (done IDs alone don't tell us when).
  return { kind: "next", day: next, doneToday: false };
}

// Is any day marked done with a local-time date equal to today? Used by the
// Today view to decide whether to show the "done — come back tomorrow" state.
export function anyDayDoneToday(): boolean {
  const row = getDb()
    .prepare(
      `SELECT date(done_at, 'localtime') as d
       FROM practice_progress
       WHERE item_id LIKE 'day:%'
       ORDER BY done_at DESC
       LIMIT 1`,
    )
    .get() as { d: string } | undefined;
  if (!row) return false;
  const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in local tz
  return row.d === today;
}
