// check:comics — the Comics section's gate (in prebuild).
//
//  1. The catalog: lib/comics-data.ts is exactly what comics/*.json generate
//     (nobody hand-edited the generated file or forgot to re-run the
//     script), every id is "mca-<appIssueId>", no list repeats an issue, and
//     the three lists carried over from Marvel Unlimited still hold all 392
//     issues with the same app ids, in the same order.
//  2. The generator's guards, on throwaway storyline files: an unmatched issue
//     keeps its whole list off the hub, "skip": true drops one issue, a
//     repeated issue is kept once.
//  3. The read-mark move (lib/comics-rekey.ts) through a throwaway database:
//     old Marvel Unlimited ids become "mca-" keys with their dates, a mark
//     already re-ticked under its new key keeps the newer one, unknown ids are
//     left alone, and a second run changes nothing.
//  4. The matcher (scripts/lib/comics-match.mjs): CBL and hand-written lists
//     parse; resolveEntry against recorded answers from the app finds the
//     right issue for every kind of entry the importer meets, and refuses to
//     guess where a person has to decide.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { STORYLINES } from "../lib/comics-data.ts";
import { LEGACY_COMIC_IDS } from "../lib/comics-legacy-ids.ts";
import { rekeyLegacyComicState } from "../lib/comics-rekey.ts";
// @ts-expect-error plain ESM, no types
import { buildStorylines, comicId } from "./generate-comics-data.mjs";
// @ts-expect-error plain ESM, no types
import { parseCbl, parseTitles, resolveEntry, makeCache, normName, normNumber } from "./lib/comics-match.mjs";

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

// ─── 1. Catalog ─────────────────────────────────────────────────────────────
console.log("1. catalog");
{
  const { built, warnings } = buildStorylines();
  assert(JSON.stringify(built) === JSON.stringify(STORYLINES), "lib/comics-data.ts matches comics/*.json (re-run scripts/generate-comics-data.mjs)");
  assert(warnings.length === 0, `no storyline left out or trimmed${warnings.length ? `: ${warnings.join("; ")}` : ""}`);
  let idsOk = true;
  let dupFree = true;
  for (const s of STORYLINES) {
    const seen = new Set<string>();
    for (const i of s.issues) {
      if (i.id !== `mca-${i.appIssueId}` || !Number.isInteger(i.appIssueId) || i.appIssueId <= 0) idsOk = false;
      if (seen.has(i.id)) dupFree = false;
      seen.add(i.id);
    }
  }
  assert(idsOk, 'every issue id is "mca-<appIssueId>" with a positive integer app id');
  assert(dupFree, "no storyline lists an issue twice");
  assert(new Set(STORYLINES.map((s) => s.slug)).size === STORYLINES.length, "storyline slugs are unique");

  const legacy = ["hickman-x-men", "hickman-secret-wars", "fraction-hawkeye"].map((slug) => STORYLINES.find((s) => s.slug === slug));
  assert(legacy.every(Boolean), "the three Marvel Unlimited-era lists are still there");
  const counts = legacy.map((s) => s?.issues.length);
  assert(JSON.stringify(counts) === JSON.stringify([149, 219, 24]), `they keep 149 / 219 / 24 issues (got ${counts.join(" / ")})`);
  const legacyApp = new Set(Object.values(LEGACY_COMIC_IDS));
  const legacyIssues = legacy.flatMap((s) => s?.issues ?? []);
  assert(Object.keys(LEGACY_COMIC_IDS).length === 392 && legacyApp.size === 392, "the frozen old-id map has 392 distinct issues");
  assert(legacyIssues.every((i) => legacyApp.has(i.appIssueId)), "every carried-over issue has an old id to move its read mark from");
  const hawkeye = legacy[2]?.issues ?? [];
  assert(hawkeye[0]?.title === "Young Avengers Presents (2008) #6" && hawkeye[0]?.appIssueId === 21930, "Hawkeye still opens on Young Avengers Presents #6 (app 21930)");
  assert(hawkeye[1]?.title === "Hawkeye (2012) #1" && hawkeye[1]?.appIssueId === 16543, "then Hawkeye (2012) #1 (app 16543)");
}

// ─── 2. Generator guards ───────────────────────────────────────────────────
console.log("2. generator guards");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comics-gen-"));
  const write = (name: string, v: unknown) => fs.writeFileSync(path.join(dir, name), JSON.stringify(v));
  write("storylines.json", ["done", "half"]);
  write("done.json", {
    slug: "done",
    title: "Done",
    source: { kind: "cbl", name: "A fan list", url: "https://example.org/list.cbl" },
    issues: [
      { title: "A #1", appIssueId: 10 },
      { title: "A #2", appIssueId: null, skip: true },
      { title: "A #3", appIssueId: 12 },
      { title: "A #1 again", appIssueId: 10 },
    ],
  });
  write("half.json", { slug: "half", title: "Half", issues: [{ title: "B #1", appIssueId: 20 }, { title: "B #2", appIssueId: null }] });
  const { built, warnings } = buildStorylines(dir);
  assert(built.length === 1 && built[0].slug === "done", "a list with an unmatched issue is left out");
  assert(warnings.some((w: string) => w.includes("left out half")), "…and says so");
  assert(JSON.stringify(built[0].issues.map((i: { id: string }) => i.id)) === JSON.stringify(["mca-10", "mca-12"]), '"skip": true drops an issue, a repeat is kept once, order holds');
  assert(warnings.some((w: string) => w.includes("listed twice")), "…and the repeat is reported");
  assert(built[0].source?.name === "A fan list", "the list keeps where it came from");
  assert(comicId(30604) === "mca-30604", "comicId prefixes the app id");
  write("storylines.json", ["done", "done"]);
  let threw = false;
  try { buildStorylines(dir); } catch { threw = true; }
  assert(threw, "a slug listed twice is an error");
  fs.rmSync(dir, { recursive: true, force: true });
}

// ─── 3. Read-mark move ─────────────────────────────────────────────────────
console.log("3. read-mark move");
{
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE comic_state (issue_id TEXT PRIMARY KEY, read_at TEXT NOT NULL)`);
  const [oldA, oldB, oldC] = Object.keys(LEGACY_COMIC_IDS);
  const ins = db.prepare(`INSERT INTO comic_state (issue_id, read_at) VALUES (?, ?)`);
  ins.run(oldA, "2026-01-01T00:00:00.000Z");
  ins.run(oldB, "2026-02-01T00:00:00.000Z");
  ins.run(`mca-${LEGACY_COMIC_IDS[oldB]}`, "2026-11-20T00:00:00.000Z"); // re-ticked after the switch
  ins.run("999999999", "2026-03-01T00:00:00.000Z"); // not a known old id
  // An old id that happens to equal some app id must not be confused with it:
  // the new keys are prefixed, so the bare number is only ever an old id.
  ins.run(`mca-${oldC}`, "2026-04-01T00:00:00.000Z");
  const moved = rekeyLegacyComicState(db);
  const rows = Object.fromEntries((db.prepare(`SELECT issue_id, read_at FROM comic_state`).all() as { issue_id: string; read_at: string }[]).map((r) => [r.issue_id, r.read_at]));
  assert(moved === 2, `two old marks moved (got ${moved})`);
  assert(rows[`mca-${LEGACY_COMIC_IDS[oldA]}`] === "2026-01-01T00:00:00.000Z" && !(oldA in rows), "an old mark moves to its new key with its date");
  assert(rows[`mca-${LEGACY_COMIC_IDS[oldB]}`] === "2026-11-20T00:00:00.000Z" && !(oldB in rows), "a mark already re-ticked keeps the newer one, and the old row goes");
  assert(rows["999999999"] === "2026-03-01T00:00:00.000Z", "an unknown id is left alone");
  assert(rows[`mca-${oldC}`] === "2026-04-01T00:00:00.000Z", "an existing new-style key is never touched");
  assert(Object.keys(rows).length === 4, "nothing else appears or disappears");
  assert(rekeyLegacyComicState(db) === 0, "a second run changes nothing");
  db.close();
}

// ─── 4. Matcher ────────────────────────────────────────────────────────────
console.log("4. matcher");
{
  assert(normName("S.H.I.E.L.D.") === normName("S.h.i.e.l.d."), "names compare without case or punctuation");
  assert(normName("Secret Wars II") === normName("Secret Wars Ii"), "…including the app's title-casing");
  assert(normNumber("#05") === "5" && normNumber("34.1") === "34.1" && normNumber("0") === "0", "issue numbers normalise (#05 → 5, 34.1 and 0 kept)");

  const cbl = parseCbl(`<?xml version="1.0" encoding="utf-8"?>
<ReadingList><Name>[Marvel] Test &amp; Friends</Name><Books>
<Book Series="X of Swords: Creation" Number="1" Volume="2020" Year="2020"><Database Name="cv" Series="130569" Issue="803652" /></Book>
<Book Series="Marauders" Number="13" Volume="2019" Year="2020" />
<Book Series="Hawkeye &amp; Mockingbird" Number="003" Volume="2010" Year="2010"></Book>
</Books></ReadingList>`);
  assert(cbl.name === "[Marvel] Test & Friends" && cbl.entries.length === 3, "a CBL file parses (name, three books, self-closing and empty forms)");
  assert(cbl.entries[0].series === "X of Swords: Creation" && cbl.entries[0].year === 2020 && cbl.entries[0].number === "1" && cbl.entries[0].comicVineId === 803652, "…with series, start year, number and the Comic Vine id");
  assert(cbl.entries[1].year === 2019 && cbl.entries[1].coverYear === 2020, "…Volume is the series year, Year the cover year");
  assert(cbl.entries[2].series === "Hawkeye & Mockingbird" && cbl.entries[2].number === "3", "…entities are decoded, leading zeros dropped");

  const titles = parseTitles(`# my list
- [ ] Hawkeye (2012) #5
House of X #1

// a note
Amazing Spider-Man (1963) #34.1
not a comic`);
  assert(titles.entries.length === 3, "a hand-written list parses, skipping comments and blanks");
  assert(titles.entries[0].series === "Hawkeye" && titles.entries[0].year === 2012 && titles.entries[0].number === "5", "…checklist markers are stripped");
  assert(titles.entries[1].year === null && titles.entries[2].number === "34.1", "…the year is optional, point issues are kept");
  assert(titles.errors.length === 1 && titles.errors[0].includes("line 7"), "…and a line it can't read is reported by number");

  // Recorded answers from www.marvelcomicsapp.com (scripts/comics-fixture/
  // api.json, made with COMICS_RECORD=… on the Mac Mini). A path the
  // recording doesn't have answers like a 404.
  const fixturePath = path.join(path.dirname(new URL(import.meta.url).pathname), "comics-fixture", "api.json");
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
  const cases = JSON.parse(fs.readFileSync(path.join(path.dirname(fixturePath), "cases.json"), "utf8")) as {
    entry: { series: string; year: number | null; number: string; coverYear?: number | null };
    expect: number | null;
    why: string;
  }[];
  const aliases = JSON.parse(fs.readFileSync(path.join(path.dirname(fixturePath), "..", "..", "comics", "series-aliases.json"), "utf8"));
  delete aliases._comment;
  const api = async (p: string) => (p in fixture ? fixture[p] : null);
  const cache = makeCache();
  for (const c of cases) {
    const r = await resolveEntry({ coverYear: null, ...c.entry }, { api, cache, aliases });
    const label = `${c.entry.series}${c.entry.year ? ` (${c.entry.year})` : ""} #${c.entry.number}`;
    if (c.expect === null) assert(r.appIssueId === null, `${label}: left for a person (${c.why})`);
    else assert(r.appIssueId === c.expect, `${label} → ${c.expect} (${c.why})${r.appIssueId !== c.expect ? `; got ${r.appIssueId}` : ""}`);
  }
}

if (failures) {
  console.error(`\ncheck:comics FAILED (${failures})`);
  process.exit(1);
}
console.log("\ncheck:comics passed");
