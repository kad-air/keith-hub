// Matching a reading-order entry ("Hawkeye (2012) #5") to its issue in the
// Marvel Comics app (www.marvelcomicsapp.com). Pure logic: the caller passes
// `api(path) -> data`, so the importer drives it against the live site (from
// inside a real browser page) and check:comics drives it against recorded
// responses. See scripts/comics-data-pipeline.md.
//
// The rule is "exactly one match or a person decides". A wrong issue in a
// reading order is worse than a missing one, so anything ambiguous comes back
// unresolved with its candidates for review — never a guess.

// ─── Normalising ───────────────────────────────────────────────────────────
// The app title-cases everything ("Ff", "S.h.i.e.l.d.", "Secret Wars Ii") and
// fan lists don't agree on punctuation, so names compare on letters and
// digits only.
export function normName(s) {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^the /, "")
    .trim();
}

// "#05" / "5" / "#5" → "5"; "#34.1" stays "34.1"; "#0" stays "0".
export function normNumber(n) {
  let s = String(n ?? "").trim().replace(/^#/, "").toLowerCase();
  s = s.replace(/^0+(?=\d)/, "");
  return s;
}

export function entryTitle(e) {
  return e.year ? `${e.series} (${e.year}) #${e.number}` : `${e.series} #${e.number}`;
}

// ─── Parsing fan lists ─────────────────────────────────────────────────────
// CBL is the reading-list format the community library uses
// (github.com/DieselTech/CBL-ReadingLists):
//   <Book Series="Hawkeye" Number="5" Volume="2012" Year="2012">
// Volume is the series' start year; Year is the issue's cover year.
// Some library files escape twice ("Hickman &amp;amp; Weaver"), so decode
// until nothing changes.
function xmlUnescape(s) {
  for (let i = 0; i < 3; i++) {
    const next = xmlUnescapeOnce(s);
    if (next === s) break;
    s = next;
  }
  return s;
}

function xmlUnescapeOnce(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g)) out[m[1]] = xmlUnescape(m[2]);
  return out;
}

export function parseCbl(xml) {
  const name = (xml.match(/<Name>([\s\S]*?)<\/Name>/) || [])[1];
  const entries = [];
  for (const m of xml.matchAll(/<Book\b([^>]*?)(\/>|>([\s\S]*?)<\/Book>)/g)) {
    const a = attrs(m[1]);
    if (!a.Series || a.Number === undefined) continue;
    const cv = m[3] ? (m[3].match(/<Database\b[^>]*Name="cv"[^>]*Issue="(\d+)"/) || [])[1] : undefined;
    const year = /^\d{4}$/.test(a.Volume ?? "") ? Number(a.Volume) : null;
    const coverYear = /^\d{4}$/.test(a.Year ?? "") ? Number(a.Year) : null;
    entries.push({
      series: a.Series.trim(),
      year,
      number: normNumber(a.Number),
      coverYear,
      ...(cv ? { comicVineId: Number(cv) } : {}),
    });
  }
  return { name: name ? xmlUnescape(name).trim() : null, entries };
}

// A list you write yourself: one issue per line, "Series (Year) #N".
// Blank lines and lines starting with # or // are ignored. The year is
// optional but strongly recommended (it's how same-named series differ).
export function parseTitles(text) {
  const entries = [];
  const errors = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/^\s*[-*]\s*(\[[ xX]\]\s*)?/, "").trim();
    if (!line || line.startsWith("//") || /^#(?!\d)/.test(line)) return;
    const m = line.match(/^(.*?)\s*(?:\((\d{4})\))?\s*#\s*([\w.½-]+)\s*$/);
    if (!m || !m[1]) {
      errors.push(`line ${i + 1}: "${raw}" (expected "Series (Year) #N")`);
      return;
    }
    entries.push({ series: m[1].trim(), year: m[2] ? Number(m[2]) : null, number: normNumber(m[3]), coverYear: null });
  });
  return { entries, errors };
}

// ─── Talking to the app ────────────────────────────────────────────────────
const PAGE = 20; // the API refuses limit > 20

function q(s) {
  return encodeURIComponent(s);
}

function yearOf(date) {
  const m = /^(\d{4})/.exec(String(date ?? ""));
  return m ? Number(m[1]) : null;
}

// Per-run cache: fan lists hit the same series over and over, so each series
// search and each series' issue list is fetched once.
export function makeCache() {
  return { seriesSearch: new Map(), seriesIssues: new Map() };
}

async function searchSeries(api, cache, name) {
  const key = normName(name);
  if (cache.seriesSearch.has(key)) return cache.seriesSearch.get(key);
  const found = [];
  // Two pages is plenty once results are filtered to an exact name; a common
  // name ("X-Men") ranks its exact-name series near the top.
  for (let offset = 0; offset < PAGE * 2; offset += PAGE) {
    const data = await api(`/api/v1/explore/search/series?query=${q(name)}&offset=${offset}&limit=${PAGE}`);
    const rows = data?.series ?? [];
    found.push(...rows);
    if (rows.length < PAGE || found.length >= (data?.totalCount ?? 0)) break;
  }
  cache.seriesSearch.set(key, found);
  return found;
}

async function seriesIssues(api, cache, seriesId) {
  if (cache.seriesIssues.has(seriesId)) return cache.seriesIssues.get(seriesId);
  const all = [];
  for (let offset = 0; ; offset += PAGE) {
    const data = await api(`/api/v1/series/${seriesId}/issues?offset=${offset}&limit=${PAGE}&sort=OLDEST`);
    const rows = data?.issues ?? [];
    all.push(...rows);
    if (!data?.hasNext || rows.length === 0) break;
    if (offset > 5000) break; // no real series is this long; stop a runaway
  }
  cache.seriesIssues.set(seriesId, all);
  return all;
}

// Several app issues can carry the same name, year and number: a reprint or
// facsimile series reuses the original's title ("X-Men (1963) #1" exists as
// the 1963 book and as 2019–2023 reprints).
//  • With a cover year (fan CBL lists have one), the issue published nearest
//    it wins, if it's within two years and clearly nearer than the rest.
//  • Without one (a hand-written list), the earliest printing wins if every
//    other match came out at least five years later: those are reprints.
// Anything closer is a real tie (Weirdworld (2015) is two series, both 2015)
// and is left for a person to settle.
function pickByDate(matches, entry) {
  const unique = [...new Map(matches.map((m) => [m.issueId, m])).values()];
  if (unique.length <= 1) return unique;
  const dated = unique.map((m) => ({ m, y: yearOf(m.publicationDate) }));
  if (dated.some((x) => x.y === null)) return unique;
  if (entry.coverYear) {
    const scored = dated.map((x) => ({ m: x.m, d: Math.abs(x.y - entry.coverYear) })).sort((a, b) => a.d - b.d);
    if (scored[0].d <= 2 && scored[1].d >= scored[0].d + 3) return [scored[0].m];
    return unique;
  }
  dated.sort((a, b) => a.y - b.y);
  if (dated[1].y - dated[0].y >= 5) return [dated[0].m];
  return unique;
}

function candidate(m, how) {
  return {
    appIssueId: m.issueId,
    title: `${m.title} ${m.issueNumber}`,
    published: m.publicationDate ?? null,
    how,
  };
}

// The app's search misses some exact names ("Infinity: The Hunt" only turns
// up for "The Hunt"; "Hank Johnson, Agent of Hydra" only for "Hank Johnson").
// These are the shorter queries to try then; results must still match the
// full name exactly.
function shorterQueries(name) {
  const out = [];
  const colon = name.lastIndexOf(":");
  if (colon > 0 && name.slice(colon + 1).trim()) out.push(name.slice(colon + 1).trim());
  const comma = name.indexOf(",");
  if (comma > 0) out.push(name.slice(0, comma).trim());
  return out.filter((x) => normName(x) && normName(x) !== normName(name));
}

async function exactSeries(api, cache, name) {
  const exact = (rows) => rows.filter((s) => normName(s.title) === normName(name));
  let found = exact(await searchSeries(api, cache, name));
  for (const alt of shorterQueries(name)) {
    if (found.length) break;
    found = exact(await searchSeries(api, cache, alt));
  }
  return found;
}

// An alias value is the app's name, optionally with the app's start year when
// it differs ("S.H.I.E.L.D. (2011)" for issues a fan list files under 2018).
function aliasTarget(value, year) {
  const m = /^(.*?)\s*\((\d{4})\)\s*$/.exec(value);
  return m ? { name: m[1], year: Number(m[2]) } : { name: value, year };
}

/**
 * Resolve one entry. Returns
 *   { appIssueId, appTitle, how }                       on exactly one match
 *   { appIssueId: null, reason, candidates: [...] }     otherwise
 * `aliases` maps a fan-list series ("Uncanny X-Men (1963)", or a bare name
 * for every year of it) to the app's name for it ("X-Men", or
 * "S.H.I.E.L.D. (2011)" when the app's start year differs too); see
 * comics/series-aliases.json.
 */
export async function resolveEntry(entry, { api, cache = makeCache(), aliases = {} }) {
  const number = normNumber(entry.number);
  const names = [{ name: entry.series, year: entry.year }];
  // Keys are "Name (Year)", or a bare "Name" for every year of it.
  const aliasKey = Object.keys(aliases).find((k) => {
    const m = /^(.*?)\s*\((\d{4})\)\s*$/.exec(k);
    if (m) return normName(m[1]) === normName(entry.series) && Number(m[2]) === entry.year;
    return normName(k) === normName(entry.series);
  });
  if (aliasKey) names.unshift(aliasTarget(aliases[aliasKey], entry.year));

  // 1. Issue search on the full title, e.g. "Hawkeye (2012) #5". One request,
  //    and right for most issues. Accept only an exact name + number (+ year).
  for (const { name, year } of names) {
    const query = year ? `${name} (${year}) #${number}` : `${name} #${number}`;
    const data = await api(`/api/v1/explore/search/issues?query=${q(query)}&offset=0&limit=${PAGE}`);
    const hits = (data?.issues ?? []).filter((i) => {
      if (normNumber(i.issueNumber) !== number) return false;
      const sName = i.series?.title ?? String(i.title).replace(/\s*\(\d{4}\)\s*$/, "");
      if (normName(sName) !== normName(name)) return false;
      if (year && i.series?.startYear && i.series.startYear !== year) return false;
      return true;
    });
    const picked = pickByDate(hits, entry);
    if (picked.length === 1) return { appIssueId: picked[0].issueId, appTitle: `${picked[0].title} ${picked[0].issueNumber}`, how: "issue-search" };
    if (picked.length > 1) {
      return { appIssueId: null, reason: "several app issues match", candidates: picked.map((m) => candidate(m, "issue-search")) };
    }
  }

  // 2. Series route: find every app series with this exact name (and start
  //    year, ±1 if none is exact), then look for the number in each. Every
  //    candidate series is checked, because the app splits some series in two.
  const matches = [];
  const near = [];
  for (const { name, year } of names) {
    const series = await exactSeries(api, cache, name);
    const start = (s) => s.publicationPeriod?.startYear ?? s.startYear ?? null;
    let pool = year ? series.filter((s) => start(s) === year) : series;
    if (year && pool.length === 0) pool = series.filter((s) => start(s) && Math.abs(start(s) - year) <= 1);
    for (const s of pool) {
      const issues = await seriesIssues(api, cache, s.seriesId);
      const hit = issues.filter((i) => normNumber(i.issueNumber) === number);
      matches.push(...hit);
      if (hit.length === 0 && issues.length) near.push(`${s.title} (${start(s)}) has ${issues.length} issues, no #${number}`);
    }
    if (matches.length) break;
  }
  const picked = pickByDate(matches, entry);
  if (picked.length === 1) return { appIssueId: picked[0].issueId, appTitle: `${picked[0].title} ${picked[0].issueNumber}`, how: "series" };
  if (picked.length > 1) {
    return { appIssueId: null, reason: "several app issues match", candidates: picked.map((m) => candidate(m, "series")) };
  }

  // 3. Nothing exact. Offer the closest things a person might mean (a renamed
  //    series, an annual), but never pick one.
  const loose = [];
  const data = await api(`/api/v1/explore/search/issues?query=${q(`${entry.series} #${number}`)}&offset=0&limit=${PAGE}`);
  for (const i of (data?.issues ?? []).filter((i) => normNumber(i.issueNumber) === number).slice(0, 5)) {
    loose.push(candidate(i, "loose-search"));
  }
  return {
    appIssueId: null,
    reason: near.length ? `not in the app: ${near.join("; ")}` : "no app series with this name and year",
    candidates: loose,
  };
}
