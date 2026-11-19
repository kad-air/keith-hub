#!/usr/bin/env node
// Import a fan reading order into the hub's Comics section.
//
//   node scripts/comics-import.mjs --slug <slug> --title "<title>" \
//     [--description "<text>"] (--cbl <file|url|library path> | --titles <file>)
//   node scripts/comics-import.mjs --slug <slug>      # re-try an existing list's misses
//
// Reads the list, finds every issue in the Marvel Comics app, writes
// comics/<slug>.json, adds the slug to comics/storylines.json, and regenerates
// lib/comics-data.ts. Issues it can't match exactly are kept with
// "appIssueId": null and their candidates under "review"; a list with any of
// those is left out of the hub until each one is fixed by hand (set its
// appIssueId, or "skip": true). Re-running keeps every id already set, so
// hand fixes stick. Full walk-through: scripts/comics-data-pipeline.md.
//
// Runs where Google Chrome is installed (the Mac Mini): the app's API only
// answers requests made from inside one of its own pages, so this opens
// www.marvelcomicsapp.com headless and calls the API from there. Signed out,
// read-only, about one request a second.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCbl, parseTitles, resolveEntry, makeCache, entryTitle, normName, normNumber } from "./lib/comics-match.mjs";
import { generate } from "./generate-comics-data.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMICS = path.join(ROOT, "comics");
const LIBRARY_RAW = "https://raw.githubusercontent.com/DieselTech/CBL-ReadingLists/main/";
const SITE = "https://www.marvelcomicsapp.com/";
const PACE_MS = 1100;

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    const key = a.slice(2);
    if (key === "dry-run") out[key] = true;
    else out[key] = argv[++i];
  }
  return out;
}

const opts = args(process.argv.slice(2));
if (!opts.slug || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(opts.slug)) {
  console.error('usage: node scripts/comics-import.mjs --slug <kebab-slug> --title "<title>" (--cbl <file|url|library path> | --titles <file>)');
  process.exit(2);
}

const dest = path.join(COMICS, `${opts.slug}.json`);
const existing = fs.existsSync(dest) ? JSON.parse(fs.readFileSync(dest, "utf8")) : null;

// ─── Read the list ─────────────────────────────────────────────────────────
async function readSource(ref) {
  if (fs.existsSync(ref)) return { text: fs.readFileSync(ref, "utf8"), url: null };
  let url = ref;
  if (!/^https:\/\//.test(ref)) url = LIBRARY_RAW + ref.split("/").map(encodeURIComponent).join("/");
  // A github.com/…/blob/… link → its raw file.
  url = url.replace(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\//, "https://raw.githubusercontent.com/$1/$2/");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`couldn't fetch ${url}: HTTP ${res.status}`);
  return { text: await res.text(), url };
}

let entries;
let source;
if (opts.cbl) {
  const { text, url } = await readSource(opts.cbl);
  const parsed = parseCbl(text);
  entries = parsed.entries;
  source = { kind: "cbl", name: parsed.name ?? path.basename(opts.cbl), url: url ?? null };
} else if (opts.titles) {
  const { entries: e, errors } = parseTitles(fs.readFileSync(opts.titles, "utf8"));
  if (errors.length) {
    console.error(`Couldn't read ${errors.length} line(s):\n  ${errors.join("\n  ")}`);
    process.exit(1);
  }
  entries = e;
  source = { kind: "titles", name: opts["source-name"] ?? path.basename(opts.titles), url: opts["source-url"] ?? null };
} else if (existing) {
  entries = existing.issues.filter((i) => i.series && i.number !== undefined);
  source = existing.source;
} else {
  console.error("Give a list with --cbl or --titles (or a --slug that already exists, to re-try its misses).");
  process.exit(2);
}
if (!entries.length) {
  console.error("The list has no issues in it.");
  process.exit(1);
}

const keyOf = (e) => `${normName(e.series)}|${e.year ?? ""}|${normNumber(e.number)}`;
const kept = new Map();
for (const i of existing?.issues ?? []) {
  if (i.series && (Number.isInteger(i.appIssueId) || i.skip)) kept.set(keyOf(i), i);
}

// ─── Open the app's site ───────────────────────────────────────────────────
const { chromium } = await import("playwright-core");
let browser;
try {
  browser = process.env.CHROME_PATH
    ? await chromium.launch({ executablePath: process.env.CHROME_PATH })
    : await chromium.launch({ channel: "chrome" });
} catch (err) {
  console.error(`Couldn't launch Google Chrome (set CHROME_PATH to use another): ${err.message}`);
  process.exit(1);
}

// COMICS_RECORD=<file> saves every API answer this run got, keyed by path —
// how scripts/comics-fixture/ was made for check:comics.
const recorded = process.env.COMICS_RECORD ? {} : null;
let lastCall = 0;
let page;
async function openSite() {
  page = await browser.newPage();
  await page.goto(SITE, { waitUntil: "domcontentloaded", timeout: 60_000 });
  // The site's own JS fetches an anonymous device id on load; the API refuses
  // requests without it.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const has = await page.evaluate(() => /d-comics-device-id=/.test(document.cookie));
    if (has) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("the site never set its device id cookie");
}

async function api(p) {
  for (let attempt = 0; ; attempt++) {
    const wait = lastCall + PACE_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    const r = await page.evaluate(async (p) => {
      const hdr = {
        "D-Comics-Client-Platform": "Web",
        "D-Comics-Device-Name": "Mac OS, Google Chrome",
        "D-Comics-Timezone": Intl.DateTimeFormat().resolvedOptions().timeZone,
        "Accept-Language": navigator.language || "en-US",
      };
      const did = (document.cookie.match(/d-comics-device-id=([^;]+)/) || [])[1];
      if (did) hdr["D-Comics-Device-Id"] = did;
      try {
        const res = await fetch(p, { headers: hdr });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        return { status: res.status, json };
      } catch (e) {
        return { status: 0, error: String(e) };
      }
    }, p);
    if (r.json?.success) {
      if (recorded) recorded[p] = r.json.data;
      return r.json.data;
    }
    const code = r.json?.error?.code ?? r.error ?? `HTTP ${r.status}`;
    if (r.status === 404) return null;
    const retry = code === "COM_0007" || code === "COM_0010" || r.status === 0 || r.status >= 500;
    if (retry && attempt < 4) {
      await new Promise((res) => setTimeout(res, 5000 * (attempt + 1)));
      continue;
    }
    if (code === "COM_0002" && attempt === 0) {
      // Most often a lost device id: start a fresh page once and retry.
      await page.close().catch(() => {});
      await openSite();
      continue;
    }
    throw new Error(`the app's API refused ${p}: ${code}`);
  }
}

// ─── Resolve ───────────────────────────────────────────────────────────────
const aliases = JSON.parse(fs.readFileSync(path.join(COMICS, "series-aliases.json"), "utf8"));
delete aliases._comment;
const cache = makeCache();
const out = [];
let fresh = 0;
try {
  await openSite();
  for (const [n, e] of entries.entries()) {
    const label = entryTitle(e);
    const prior = kept.get(keyOf(e));
    if (prior) {
      out.push({ ...prior, coverYear: e.coverYear ?? prior.coverYear ?? null, ...(e.comicVineId ? { comicVineId: e.comicVineId } : {}) });
      continue;
    }
    const r = await resolveEntry(e, { api, cache, aliases });
    fresh++;
    const row = {
      title: label,
      series: e.series,
      year: e.year,
      number: normNumber(e.number),
      coverYear: e.coverYear ?? null,
      ...(e.comicVineId ? { comicVineId: e.comicVineId } : {}),
      appIssueId: r.appIssueId,
    };
    if (r.appIssueId === null) row.review = { reason: r.reason, candidates: r.candidates };
    out.push(row);
    const mark = r.appIssueId === null ? "✗" : "✓";
    console.log(`${String(n + 1).padStart(4)}/${entries.length} ${mark} ${label}${r.appIssueId === null ? `  (${r.reason})` : `  → ${r.appIssueId}`}`);
  }
} finally {
  await browser.close();
  if (recorded) fs.writeFileSync(process.env.COMICS_RECORD, JSON.stringify(recorded, null, 1) + "\n");
}

// ─── Write ─────────────────────────────────────────────────────────────────
const storyline = {
  slug: opts.slug,
  title: opts.title ?? existing?.title ?? source.name,
  ...((opts.description ?? existing?.description) ? { description: opts.description ?? existing.description } : {}),
  source,
  issues: out,
};
const missing = out.filter((i) => i.appIssueId === null && !i.skip);

if (opts["dry-run"]) {
  console.log(`\nDry run: nothing written. ${out.length - missing.length}/${out.length} matched.`);
} else {
  fs.writeFileSync(dest, JSON.stringify(storyline, null, 2) + "\n");
  const indexPath = path.join(COMICS, "storylines.json");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  if (!index.includes(opts.slug)) {
    index.push(opts.slug);
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n");
  }
  console.log(`\nWrote comics/${opts.slug}.json: ${out.length - missing.length}/${out.length} matched (${fresh} looked up now).`);
  generate();
}

if (missing.length) {
  console.log(`\n${missing.length} issue(s) need a hand fix in comics/${opts.slug}.json before the list shows on the hub.`);
  console.log(`Set each one's "appIssueId" (candidates are listed under "review"), or "skip": true if the app doesn't have it:`);
  for (const m of missing) {
    console.log(`  • ${m.title}: ${m.review?.reason ?? ""}`);
    for (const c of m.review?.candidates ?? []) console.log(`      ${c.appIssueId}  ${c.title}${c.published ? ` (${c.published})` : ""}`);
  }
  process.exitCode = 3;
}
