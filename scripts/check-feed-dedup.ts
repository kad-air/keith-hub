// Feed gate: dismissed articles stay dismissed, and one piece is one card.
//
//   npm run check:feed        (runs in `prebuild`)
//
// Two user-visible bugs, both found on 2026-09-04, each with a runnable
// assertion here so it cannot quietly come back:
//
//  1. "I dismissed that Verge review and it's back" / "the same article is in
//     Reading AND Tech Review". The Verge reviews feed is a TAG applied after
//     publication, so a review's verge-full copy lands first; when the
//     verge-reviews copy arrived the old dedup deleted the full-feed row AND
//     its item_state — the dismissal (or the save, or the opened-history
//     entry) with it — and matched on exact URL, which the two feeds do not
//     share once a section prefix or slug has been edited. Now: matched on the
//     WordPress post id, and the loser's state moves onto the winner.
//  2. "I clear stuff, it comes back." Retention hard-deleted a dismissed row
//     after 7 days, but the reviews feed runs ~3 weeks deep (measured on the
//     committed snapshot below) and podcast feeds carry every episode ever,
//     so the next crawl re-inserted the row as a brand-new unread item under a
//     new id. Now: a deleted row leaves a tombstone the fetchers honour. The
//     same retention step also deleted every NEVER-SEEN item older than the
//     retention window that had no state row — i.e. anything in a category
//     whose TTL is longer than retention — on every crawl. Now: only rows the
//     state says were dismissed are deleted.
//
// The client half of bug 2 (a dismiss request killed by iOS suspending the
// PWA, then the resume-refresh bringing the card back) is the dismiss outbox
// in lib/dismiss-outbox.ts; it is pinned statically at the bottom, since
// nothing here runs a browser.
//
// What runs: the REAL fetchAllSources / pruneExpiredUnread / markReadBulk /
// dedupCrossSourceDuplicates against a throwaway SQLite created by the real
// lib/db.ts, with the three sources pointed at a local HTTP server whose
// feeds this script mutates between crawls. Anchored on two committed
// snapshots of the real Verge feeds (feed-fixture/verge-*.xml, bodies
// stripped) for the guid/link shapes the post-id matcher must handle and for
// the reviews feed's depth, which is the whole reason resurrection is real.
//
// Deliberately NOT covered: the Bluesky fetcher's tombstone skip (needs
// credentials and a network; pinned by grep only) and the outbox in a real
// browser.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

const reviewsSnapshot = read("feed-fixture/verge-reviews.xml");
const fullSnapshot = read("feed-fixture/verge-full.xml");
const feedClientSrc = read("components/FeedClient.tsx");
const savedClientSrc = read("components/SavedClient.tsx");
const readClientSrc = read("components/ReadClient.tsx");
const outboxSrc = read("lib/dismiss-outbox.ts");
const queriesSrc = read("lib/queries.ts");
const blueskySrc = read("lib/bluesky.ts");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "feed-dedup-check-"));
process.chdir(tmp);

const { getDb } = await import("../lib/db.ts");
const { saveConfigYaml } = await import("../lib/config.ts");
const { fetchAllSources, fetchRssSource, vergePostId } = await import("../lib/fetcher.ts");
const { markReadBulk, loadDismissedKeys, getCategoryCounts } = await import("../lib/queries.ts");

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}
function section(title: string): void {
  console.log(`\n${title}`);
}

// ── A local feed server the script can rewrite between crawls ──────────────
const feeds = new Map<string, string>();
const server = http.createServer((req, res) => {
  const body = feeds.get(req.url ?? "");
  if (body === undefined) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": "application/rss+xml" }).end(body);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

interface FeedItem {
  guid: string;
  link: string;
  title: string;
  pub: Date;
  audio?: boolean;
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
function rss(items: FeedItem[]): string {
  return (
    `<?xml version="1.0"?><rss version="2.0"><channel><title>fixture</title><link>${base}</link>` +
    items
      .map(
        (i) =>
          `<item><title>${esc(i.title)}</title><link>${esc(i.link)}</link>` +
          `<guid isPermaLink="false">${esc(i.guid)}</guid><pubDate>${i.pub.toUTCString()}</pubDate>` +
          (i.audio ? `<enclosure url="${base}/ep.mp3" type="audio/mpeg" length="1"/>` : "") +
          `</item>`
      )
      .join("") +
    `</channel></rss>`
  );
}
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);
const daysAgo = (d: number) => hoursAgo(d * 24);
const V = "https://www.theverge.com";

// ── The live config: three real source ids, TTL for reviews LONGER than
// retention (a Tune knob away, and the landmine the orphan delete tripped) ──
function configYaml(sourceIds: string[]): string {
  const all: Record<string, string> = {
    "verge-full": `  - id: verge-full\n    name: The Verge\n    type: rss\n    category: reading\n    url: ${base}/full.xml\n`,
    "verge-reviews": `  - id: verge-reviews\n    name: Verge Reviews\n    type: rss\n    category: tech_review\n    url: ${base}/reviews.xml\n`,
    vergecast: `  - id: vergecast\n    name: Vergecast\n    type: podcast\n    category: podcasts\n    url: ${base}/vergecast.xml\n`,
  };
  return (
    `app:\n  poll_interval_minutes: 5\nalgorithm:\n  ttl_days:\n    reading: 7\n    tech_review: 14\n    podcasts: 7\n  retention_days: 7\nsources:\n` +
    sourceIds.map((id) => all[id]).join("")
  );
}

const db = getDb();
const { errors } = saveConfigYaml(configYaml(["verge-full", "verge-reviews", "vergecast"]));
assert(errors.length === 0, `live config seeded through the real validator (${errors.join("; ") || "no errors"})`);

const q = <T = Record<string, unknown>>(sql: string, ...params: unknown[]) =>
  db.prepare(sql).all(...params) as T[];
const one = <T = Record<string, unknown>>(sql: string, ...params: unknown[]) =>
  db.prepare(sql).get(...params) as T | undefined;
type Row = { id: string; source_id: string; external_id: string; url: string; read_at: string | null; saved_at: string | null; consumed_at: string | null };
const rowsForPost = (pid: string): Row[] =>
  q<Row>(
    `SELECT i.id, i.source_id, i.external_id, i.url, ist.read_at, ist.saved_at, ist.consumed_at
     FROM items i LEFT JOIN item_state ist ON ist.item_id = i.id
     WHERE i.source_id IN ('verge-full','verge-reviews')`
  ).filter((r) => vergePostId(r) === pid);
const unread = (category: string) =>
  one<{ n: number }>(
    `SELECT COUNT(*) n FROM items i LEFT JOIN item_state ist ON ist.item_id = i.id
     JOIN sources s ON s.id = i.source_id WHERE ist.read_at IS NULL AND s.category = ?`,
    category
  )!.n;
const crawl = async () => {
  const summary = await fetchAllSources(db);
  return summary;
};

// ── Anchors on the committed real snapshots ────────────────────────────────
section("Anchors: the real Verge feeds");
const parseSnap = (xml: string) =>
  [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => ({
    guid: /<guid[^>]*>([^<]+)<\/guid>/.exec(m[1])![1],
    link: /<link>([^<]+)<\/link>/.exec(m[1])![1],
    pub: new Date(/<pubDate>([^<]+)<\/pubDate>/.exec(m[1])![1]),
  }));
const realReviews = parseSnap(reviewsSnapshot);
const realFull = parseSnap(fullSnapshot);
const spanDays = (Math.max(...realReviews.map((i) => +i.pub)) - Math.min(...realReviews.map((i) => +i.pub))) / 86400e3;
assert(realReviews.length >= 4 && realFull.length >= 4, `snapshots parsed (${realReviews.length} reviews, ${realFull.length} full-feed items)`);
assert(spanDays > 7, `the reviews feed carries items older than the 7-day retention window (span ${spanDays.toFixed(1)} days) — why a deleted dismissal came back`);
for (const i of [...realReviews, ...realFull]) {
  const fromLink = /\/(\d{5,})\//.exec(i.link)?.[1];
  assert(vergePostId({ external_id: i.guid, url: i.link }) === fromLink && !!fromLink, `post id from guid matches the link path: ${i.guid.replace(V, "")} ↔ ${i.link.replace(V, "").slice(0, 40)}`);
}
assert(realFull.some((i) => /\/auto-draft$/.test(i.guid)), "the full feed ships the `/<id>/auto-draft` guid shape (matcher must read the id out of the path)");
assert(realFull.some((i) => /\/podcast\//.test(i.link)), "the full feed carries a Vergecast episode as an article under /podcast/");
// The key the tombstones and the upsert share is the guid, not the link.
feeds.set("/real-full.xml", fullSnapshot);
db.prepare(`INSERT INTO sources (id, name, type, category) VALUES ('verge-full', 'The Verge', 'rss', 'reading')`).run();
const inserted = await fetchRssSource(
  { id: "verge-full", name: "The Verge", type: "rss", category: "reading", url: `${base}/real-full.xml` },
  db
);
const realKeys = q<{ external_id: string }>(`SELECT external_id FROM items WHERE source_id = 'verge-full'`).map((r) => r.external_id).sort();
assert(inserted === realFull.length && JSON.stringify(realKeys) === JSON.stringify(realFull.map((i) => i.guid).sort()), "the fetcher keys real items by their guid — the (source_id, external_id) the tombstones are written against");
db.exec(`DELETE FROM item_state; DELETE FROM items; DELETE FROM dismissed_keys`);

// ── Crawl 1: an ordinary day ───────────────────────────────────────────────
section("Crawl 1: full feed + reviews + the podcast");
const A = { guid: `${V}/?p=301001`, link: `${V}/tech/301001/a-thing`, title: "A thing", pub: hoursAgo(1) };
const B = { guid: `${V}/?p=301003`, link: `${V}/tech/301003/b-thing`, title: "B thing", pub: hoursAgo(2) };
const P = { guid: `${V}/?p=301002`, link: `${V}/podcast/301002/episode-page`, title: "The AGI episode", pub: hoursAgo(3) };
const C = { guid: `${V}/301005/auto-draft`, link: `${V}/entertainment/301005/c-thing`, title: "C thing", pub: hoursAgo(4) };
const R0 = { guid: `${V}/?p=300900`, link: `${V}/tech/300900/old-review`, title: "Old review", pub: daysAgo(20) };
const R1 = { guid: `${V}/?p=300901`, link: `${V}/tech/300901/recent-review`, title: "Recent review", pub: daysAgo(2) };
const EP = { guid: "ep-1", link: `${base}/ep`, title: "The AGI episode", pub: hoursAgo(3), audio: true };
feeds.set("/full.xml", rss([A, B, P, C]));
feeds.set("/reviews.xml", rss([R0, R1]));
feeds.set("/vergecast.xml", rss([EP]));
let s = await crawl();
assert(s.rss === 7, `7 new rows reported (${s.rss})`);
assert(unread("reading") === 3, `Reading shows A, B, C (${unread("reading")})`);
assert(one(`SELECT 1 FROM items WHERE source_id='verge-full' AND url LIKE '%/podcast/%'`) === undefined, "the episode's article twin is folded into the podcast row");
assert(unread("podcasts") === 1, "the episode itself is unread in Podcasts");
assert(unread("tech_review") === 1, "the 20-day-old review is TTL-pruned, the 2-day-old one is unread");
assert(rowsForPost("300900")[0]?.read_at !== null && rowsForPost("300900").length === 1, "TTL-pruned review keeps its row (read, not deleted)");

// The user acts: dismisses A, saves B, opens C.
const aId = rowsForPost("301001")[0].id;
const bId = rowsForPost("301003")[0].id;
const cId = rowsForPost("301005")[0].id;
assert(markReadBulk(db, [aId]) === 1, "dismiss A via the bulk path");
db.prepare(`INSERT INTO item_state (item_id, saved_at, read_at) VALUES (?, ?, ?)`).run(bId, new Date().toISOString(), new Date().toISOString());
db.prepare(`INSERT INTO item_state (item_id, consumed_at, read_at) VALUES (?, ?, ?)`).run(cId, new Date().toISOString(), new Date().toISOString());

// ── Crawl 2: the desk tags A, B and C as reviews — under edited URLs ───────
section("Crawl 2: the reviews feed picks up A, B, C later, with different URLs");
const A2 = { guid: `${V}/?p=301001`, link: `${V}/reviews/301001/a-thing-review`, title: "A thing review", pub: A.pub };
const B2 = { guid: `${V}/?p=301003`, link: `${V}/reviews/301003/b-thing-review`, title: "B thing review", pub: B.pub };
const C2 = { guid: `${V}/?p=301005`, link: `${V}/reviews/301005/c-thing-review`, title: "C thing review", pub: C.pub };
feeds.set("/reviews.xml", rss([R0, R1, A2, B2, C2]));
s = await crawl();
for (const [pid, what, check] of [
  ["301001", "dismissed → still dismissed", (r: Row) => r.read_at !== null && r.saved_at === null && r.consumed_at === null],
  ["301003", "saved → still saved (and read)", (r: Row) => r.saved_at !== null && r.read_at !== null],
  ["301005", "opened → still in the read history", (r: Row) => r.consumed_at !== null && r.read_at !== null],
] as const) {
  const rows = rowsForPost(pid);
  assert(rows.length === 1, `post ${pid}: exactly one row survives (${rows.length})`);
  assert(rows[0]?.source_id === "verge-reviews" && rows[0]?.url.includes("/reviews/"), `post ${pid}: the review copy wins, under its own URL`);
  assert(!!rows[0] && check(rows[0]), `post ${pid}: ${what}`);
}
assert(unread("tech_review") === 1, `Tech Review still shows only the genuinely-unread review (${unread("tech_review")})`);
assert(unread("reading") === 0, "Reading shows none of the three");
assert(one(`SELECT COUNT(*) n FROM item_state WHERE saved_at IS NOT NULL`)!.n === 1, "/saved still has one entry");
assert(one(`SELECT COUNT(*) n FROM item_state WHERE consumed_at IS NOT NULL`)!.n === 1, "/read still has one entry");
assert(one(`SELECT COUNT(*) n FROM dismissed_keys WHERE source_id='verge-full' AND reason='folded'`)!.n === 4, "the four folded full-feed copies (A, B, C, the episode) are tombstoned as 'folded'");

// ── Crawl 3: nothing changed upstream — nothing may move ──────────────────
section("Crawl 3: idempotent");
const before = JSON.stringify(q(`SELECT i.id, i.source_id, ist.read_at, ist.saved_at, ist.consumed_at FROM items i LEFT JOIN item_state ist ON ist.item_id=i.id ORDER BY i.id`));
s = await crawl();
const after = JSON.stringify(q(`SELECT i.id, i.source_id, ist.read_at, ist.saved_at, ist.consumed_at FROM items i LEFT JOIN item_state ist ON ist.item_id=i.id ORDER BY i.id`));
assert(s.rss === 0, `a crawl over unchanged feeds reports 0 new items — the "N new items" toast anchor (${s.rss})`);
assert(before === after, "no row and no state changed");

// ── Crawl 4: retention runs on old dismissals — they must not come back ───
section("Crawl 4: retention on a feed that still carries the item");
const r0Id = rowsForPost("300900")[0].id;
db.prepare(`UPDATE item_state SET read_at = ? WHERE item_id IN (?, ?)`).run(daysAgo(8).toISOString(), r0Id, rowsForPost("301001")[0].id);
s = await crawl();
assert(rowsForPost("300900").length === 0 && rowsForPost("301001").length === 0, "both dismissed reviews are hard-deleted");
assert(loadDismissedKeys(db, "verge-reviews", "dismissed").has(`${V}/?p=300900`) && loadDismissedKeys(db, "verge-reviews", "dismissed").has(`${V}/?p=301001`), "…and tombstoned as 'dismissed'");
assert(s.rss === 0 && unread("tech_review") === 1 && unread("reading") === 0, `the feeds still carry both and nothing came back (new=${s.rss}, tech_review=${unread("tech_review")}, reading=${unread("reading")})`);
s = await crawl();
assert(s.rss === 0 && rowsForPost("300900").length === 0 && rowsForPost("301001").length === 0, "…and not on the crawl after that either");

// ── A review whose full-feed twin was tombstoned long ago is born read ─────
section("A late-tagged review inherits a tombstoned dismissal");
const D = { guid: `${V}/?p=301007`, link: `${V}/tech/301007/d-thing`, title: "D thing", pub: daysAgo(1) };
db.prepare(`INSERT INTO dismissed_keys (source_id, external_id, dismissed_at, reason) VALUES ('verge-full', ?, ?, 'dismissed')`).run(D.guid, daysAgo(9).toISOString());
feeds.set("/reviews.xml", rss([R0, R1, A2, B2, C2, D]));
s = await crawl();
assert(rowsForPost("301007").length === 1 && rowsForPost("301007")[0].read_at !== null, "the review copy arrives already dismissed");
assert(unread("tech_review") === 1, `Tech Review unchanged (${unread("tech_review")})`);

// ── TTL longer than retention: never-seen items must survive ───────────────
section("Never-seen items survive retention (TTL 14d > retention 7d)");
const r1 = rowsForPost("300901")[0];
db.prepare(`UPDATE items SET published_at = ? WHERE id = ?`).run(daysAgo(10).toISOString(), r1.id);
s = await crawl();
const r1After = rowsForPost("300901")[0];
assert(!!r1After && r1After.id === r1.id && r1After.read_at === null, "a 10-day-old unread review keeps its id and stays unread (the old orphan delete re-minted it every crawl)");
assert(s.rss === 0, `…and is not reported as new (${s.rss})`);

// ── markReadBulk tolerates dead ids (the outbox replays until 2xx) ─────────
section("markReadBulk");
let threw = false;
let n = 0;
try {
  n = markReadBulk(db, [r1.id, "not-a-row", aId]);
} catch {
  threw = true;
}
assert(!threw && n === 1, `dead ids are ignored, live ones marked (${n} of 3)`);
assert(rowsForPost("300901")[0].read_at !== null, "the live id is now read");
assert(markReadBulk(db, ["not-a-row", r1.id], { unread: true }) === 1 && rowsForPost("300901")[0].read_at === null, "undo through the same path, same tolerance");

// ── Removing a source removes its tombstones ───────────────────────────────
section("Source removal drops its tombstones");
const epId = one<{ id: string }>(`SELECT id FROM items WHERE source_id='vergecast'`)!.id;
markReadBulk(db, [epId]);
db.prepare(`UPDATE item_state SET read_at = ? WHERE item_id = ?`).run(daysAgo(8).toISOString(), epId);
await crawl();
assert(loadDismissedKeys(db, "vergecast").size === 1, "the dismissed episode is tombstoned");
saveConfigYaml(configYaml(["verge-full", "verge-reviews"]));
await crawl();
assert(loadDismissedKeys(db, "vergecast").size === 0 && one(`SELECT 1 FROM sources WHERE id='vergecast'`) === undefined, "…and gone with its source");
assert(getCategoryCounts(db).tech_review === 1, "counts still add up");

// ── Static pins: the client half, and the landmines ───────────────────────
section("Static pins");
assert(!/fetch\(["'`]\/api\/items\/read-bulk/.test(feedClientSrc) && !/\/api\/items\/\$\{[^}]+\}\/(read|unread)`/.test(feedClientSrc), "FeedClient never posts a dismissal directly — every one rides the outbox");
assert((feedClientSrc.match(/dismissViaOutbox\(/g) ?? []).length >= 4, "dismiss, clear-above, dismiss-visible and undo all go through dismissViaOutbox");
const vis = feedClientSrc.indexOf("function onVisibilityChange");
const flushIdx = feedClientSrc.indexOf("flushDismissOutbox()", vis);
const refreshIdx = feedClientSrc.indexOf('"/api/refresh"', vis);
assert(vis > 0 && flushIdx > 0 && flushIdx < refreshIdx, "the resume refresh replays the outbox BEFORE it crawls and refetches");
assert(/await flushDismissOutbox\(\);\s*\n\s*const res = await fetch\("\/api\/refresh"/.test(feedClientSrc), "the manual refresh does too");
assert(/feedMountedThisDocument/.test(feedClientSrc) && /remounted \|\| replayed/.test(feedClientSrc), "a client-side return to the feed refetches instead of trusting Next's router cache");
assert(/keepalive: true/.test(outboxSrc), "the outbox sends with keepalive so a backgrounded PWA can finish the request");
const keepalives = [feedClientSrc, savedClientSrc, readClientSrc].map((src) => (src.match(/\/(open|save)`, \{ method: "POST", keepalive: true \}/g) ?? []).length);
assert(keepalives.every((k) => k === 2), `open and save carry keepalive in all three clients (${keepalives.join("/")})`);
assert(!/NOT IN \(SELECT item_id FROM item_state\)/.test(queriesSrc), "the orphan delete (never-seen items hard-deleted by retention) has not come back");
assert(/loadDismissedKeys\(db, source\.id\)/.test(blueskySrc), "the Bluesky fetcher honours tombstones too (not exercised here — needs credentials)");

server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\ncheck:feed OK" : `\ncheck:feed FAILED — ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
