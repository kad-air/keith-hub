#!/usr/bin/env node
//
// 🔴 THE BOOKS APP TOKEN GATE: a native client (a private Sheafs build) gets
// /api/books/* on a bearer token — and nothing else in the hub.
//
//   npm run check:books:app-token   (standalone)
//   npm run build                   (via prebuild)
//
// lib/books/appToken.ts + middleware.ts. A mistake here has no error surface
// on the happy path: a token that opens too much (the whole hub, or a hub
// with the token unset) works perfectly for the app, and a cookie path that
// changed would only show as a login loop on the phone.
//
//  1. THE TOKEN, pure: Bearer parsing, the constant-time compare, fail-closed
//     when BOOKS_APP_TOKEN is unset or blank, wrong tokens refused.
//  2. THE REAL MIDDLEWARE, driven with NextRequest:
//       · no token set → every bearer refused (and never a fallback to
//         FEED_PASSWORD or BOOKS_API_KEY);
//       · wrong token → refused;
//       · right token → through on /api/books/* only, refused on every other
//         /api route and on the pages;
//       · the cookie path is unchanged (valid cookie through everywhere,
//         invalid cookie 401/redirect, no FEED_PASSWORD = open, as before).
//  3. THE ENDPOINTS the app uses, through the real route handlers in a
//     throwaway database. The lookup key is the partial MD5 the OFFLINE Python
//     reference computed for books-fixture/fixture.epub (expected.json — the
//     digest check:books:bytes anchors on), and the book it must find has the
//     title/author/series that file's OPF really carries. A replaced file's
//     OLD key still finds the book. Stats are exactly what the page renders.
//     The fields the contract (docs/books-app-api.md) promises are present
//     with the promised types.
//  4. ASK OVER THE WIRE: the POST's NDJSON stream against a fake Anthropic
//     server on localhost — meta, text…, done; an API error is an `error`
//     event and the question is not kept.
//  5. STATIC: appToken.ts is edge-safe (imports nothing), reads only
//     BOOKS_APP_TOKEN, the middleware checks it AFTER the cookie, /api/books
//     is not exempted from the matcher, the stats route makes the page's
//     call, and every endpoint the contract lists exists with that method.
//
// What this cannot see: timing. The compare is constant-time by construction
// (fixed-length digests, no early exit); no build can measure it.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const fixture = (name: string) => fs.readFileSync(path.resolve(repoRoot, "books-fixture", name));
const source = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), "utf8");
const expected = JSON.parse(source("books-fixture/expected.json"));

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

// Fixed, not random: a random token could make a "wrong token" case pass by luck.
const TOKEN = "5f0c3a9e1b7d4c2a8e6f0b3d9a1c7e5f2b8d4a6c0e9f1b3d5a7c9e2f4b6d8a0c";
const PASSWORD = "check-password";
const API_KEY = "4d2b9f7e1c3a5b8d0f6e2a4c9b1d7f3e5a8c0b2d4f6e9a1c3b5d7f0e2a4c6b8d";

const { NextRequest } = await import("next/server");
const { middleware, config } = await import("../middleware.ts");
const { deriveAuthToken } = await import("../lib/auth.ts");
const { appTokenAllows, bearerToken, tokensEqual, isBooksApiPath } = await import("../lib/books/appToken.ts");

function setEnv(env: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

type Opts = { method?: string; auth?: string; cookie?: string };
async function mw(url: string, opts: Opts = {}): Promise<Response> {
  const headers = new Headers();
  if (opts.auth != null) headers.set("authorization", opts.auth);
  if (opts.cookie != null) headers.set("cookie", `hub-auth=${opts.cookie}`);
  return middleware(new NextRequest(`http://localhost${url}`, { method: opts.method ?? "GET", headers }));
}
const through = (r: Response) => r.headers.get("x-middleware-next") === "1";
const refusedApi = (r: Response) => !through(r) && r.status === 401;
const refusedPage = (r: Response) => !through(r) && (r.status === 302 || r.status === 307) && /\/login$/.test(r.headers.get("location") ?? "");

const BOOK_ID = "0b6f1c1e-7d3a-4c55-9a51-2f7f6f0e9d11";
const BOOKS_PATHS: Array<[string, string]> = [
  ["GET", "/api/books"],
  ["GET", "/api/books/stats"],
  ["GET", `/api/books/by-md5/${expected.partial_md5}`],
  ["GET", `/api/books/${BOOK_ID}`],
  ["PUT", `/api/books/${BOOK_ID}`],
  ["POST", `/api/books/${BOOK_ID}/to-read`],
  ["GET", `/api/books/${BOOK_ID}/cover`],
  ["GET", `/api/books/${BOOK_ID}/ask`],
  ["POST", `/api/books/${BOOK_ID}/ask`],
  ["DELETE", `/api/books/${BOOK_ID}/ask`],
];
const OTHER_API: string[] = [
  "/api/items",
  "/api/refresh",
  "/api/comics/state",
  "/api/hoops/teams",
  "/api/push/subscribe",
  "/api/charts",
  "/api/bookshelf",
  "/api/books-admin",
  "/api/booksx/stats",
  "/api/books/%2e%2e/items", // normalised by the URL parser to /api/items
  `/api/books/${BOOK_ID}%2F..%2F..%2Fitems`,
  "/api/books/..%2fitems",
];
const PAGES: string[] = ["/", "/books", "/books/stats", `/books/${BOOK_ID}`, `/books/${BOOK_ID}/ask`, "/saved", "/hoops"];

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n1. the token:");
{
  assert(bearerToken(`Bearer ${TOKEN}`) === TOKEN, "Bearer <token> is read");
  assert(
    bearerToken(`bearer ${TOKEN}`) === TOKEN && bearerToken(`BEARER ${TOKEN}`) === TOKEN,
    "the scheme is case-insensitive (RFC 9110 §11.1)",
  );
  assert(
    bearerToken(TOKEN) === null &&
      bearerToken(`Basic ${TOKEN}`) === null &&
      bearerToken("Bearer ") === null &&
      bearerToken("Bearer") === null &&
      bearerToken(`Bearer ${TOKEN} extra`) === null &&
      bearerToken(null) === null,
    "no scheme, another scheme, an empty token, or trailing junk → no token",
  );
  assert((await tokensEqual(TOKEN, TOKEN)) === true, "equal tokens compare equal");
  assert(
    !(await tokensEqual(TOKEN, TOKEN.slice(0, -1))) &&
      !(await tokensEqual(TOKEN, TOKEN + "0")) &&
      !(await tokensEqual(TOKEN, TOKEN.slice(0, -1) + "d")) &&
      !(await tokensEqual(TOKEN, TOKEN.toUpperCase())) &&
      !(await tokensEqual(TOKEN, "")),
    "a prefix, an extension, one changed character, a case change, empty → unequal",
  );
  const ok = (p: string, h: string | null, e: string | undefined) => appTokenAllows(p, h, e);
  assert((await ok("/api/books/stats", `Bearer ${TOKEN}`, TOKEN)) === true, "right token on /api/books/stats → allowed");
  assert(
    !(await ok("/api/books/stats", `Bearer ${TOKEN}`, undefined)) &&
      !(await ok("/api/books/stats", `Bearer ${TOKEN}`, "")) &&
      !(await ok("/api/books/stats", `Bearer ${TOKEN}`, "   ")) &&
      !(await ok("/api/books/stats", "Bearer ", "")),
    "🔴 BOOKS_APP_TOKEN unset or blank → refused (fail closed), even for an empty bearer",
  );
  assert(
    (await ok("/api/books/stats", `Bearer ${TOKEN}`, `${TOKEN}\n`)) === true,
    "a trailing newline pasted into the env var doesn't lock the app out",
  );
  assert(
    !(await ok("/api/items", `Bearer ${TOKEN}`, TOKEN)) && !(await ok("/books", `Bearer ${TOKEN}`, TOKEN)),
    "🔴 right token off /api/books → refused",
  );
  assert(
    isBooksApiPath("/api/books") &&
      isBooksApiPath(`/api/books/${BOOK_ID}/ask`) &&
      !isBooksApiPath("/api/bookshelf") &&
      !isBooksApiPath("/api/books-admin") &&
      !isBooksApiPath("/api/books/..%2Fitems") &&
      !isBooksApiPath("/api/books/%2E%2E/items") &&
      !isBooksApiPath("/api/books/x%5C..%5Citems") &&
      !isBooksApiPath("/books"),
    "the scope: /api/books and /api/books/… only; a look-alike prefix or an encoded dot/slash/backslash is out",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n2. the real middleware:");
{
  const cookie = await deriveAuthToken(PASSWORD);

  // No token configured.
  setEnv({ FEED_PASSWORD: PASSWORD, BOOKS_APP_TOKEN: undefined, BOOKS_API_KEY: API_KEY });
  let all = true;
  for (const [method, p] of BOOKS_PATHS) all &&= refusedApi(await mw(p, { method, auth: `Bearer ${TOKEN}` }));
  assert(all, "🔴 BOOKS_APP_TOKEN unset → a bearer is refused (401) on every /api/books route");
  assert(
    refusedApi(await mw("/api/books/stats", { auth: `Bearer ${PASSWORD}` })) &&
      refusedApi(await mw("/api/books/stats", { auth: `Bearer ${API_KEY}` })) &&
      refusedApi(await mw("/api/books/stats", { auth: `Bearer ${cookie}` })),
    "🔴 …and nothing else stands in for it: not FEED_PASSWORD, not BOOKS_API_KEY, not the cookie's value",
  );
  setEnv({ BOOKS_APP_TOKEN: "" });
  assert(refusedApi(await mw("/api/books/stats", { auth: "Bearer " })), "BOOKS_APP_TOKEN blank → refused");

  // Token configured.
  setEnv({ BOOKS_APP_TOKEN: TOKEN });
  const wrong = [
    `Bearer ${TOKEN.slice(0, -1)}`,
    `Bearer ${TOKEN}0`,
    `Bearer ${TOKEN.slice(0, -1)}d`,
    `Bearer ${TOKEN.toUpperCase()}`,
    `Bearer ${PASSWORD}`,
    `Bearer ${API_KEY}`,
    `Bearer ${cookie}`,
    `Basic ${TOKEN}`,
    TOKEN,
    "Bearer ",
  ];
  all = true;
  for (const auth of wrong) all &&= refusedApi(await mw("/api/books/stats", { auth }));
  assert(all, "🔴 a wrong token (prefix, extension, one char off, case, the password, the device key, the cookie) → 401");
  assert(refusedApi(await mw(`/api/books/stats?token=${TOKEN}`)), "the token in the query string is not a credential");

  all = true;
  for (const [method, p] of BOOKS_PATHS) all &&= through(await mw(p, { method, auth: `Bearer ${TOKEN}` }));
  assert(all, "🔴 right token → through on every /api/books route the app uses (each method)");
  assert(through(await mw("/api/books/stats", { auth: `bearer ${TOKEN}` })), "…with the scheme in any case");

  all = true;
  for (const p of OTHER_API) {
    const r = await mw(p, { auth: `Bearer ${TOKEN}` });
    if (!refusedApi(r)) console.error(`    (through or not 401: ${p} → ${r.status})`);
    all &&= refusedApi(r);
  }
  assert(all, "🔴 right token → 401 on every other /api route, look-alike prefixes and encoded traversal included");
  all = true;
  for (const p of PAGES) all &&= refusedPage(await mw(p, { auth: `Bearer ${TOKEN}` }));
  assert(all, "🔴 right token → still redirected to /login on the pages (/books included)");
  const tracker = await mw("/api/trackers/books", { auth: `Bearer ${TOKEN}` });
  assert(tracker.status === 404, "the hidden-Tracking 404 still comes first");

  // The cookie path, unchanged.
  all = true;
  for (const [method, p] of BOOKS_PATHS) all &&= through(await mw(p, { method, cookie }));
  for (const p of [...OTHER_API.slice(0, 6), ...PAGES]) all &&= through(await mw(p, { cookie }));
  assert(all, "cookie path: a valid hub-auth cookie → through on /api/books, every other /api route and the pages");
  assert(
    through(await mw("/api/books/stats", { cookie, auth: `Bearer ${TOKEN}x` })) &&
      through(await mw("/api/items", { cookie, auth: `Bearer ${TOKEN}` })),
    "cookie path: a valid cookie wins whatever the Authorization header says",
  );
  assert(
    refusedApi(await mw("/api/books/stats", { cookie: cookie.slice(0, -1) + "0" })) &&
      refusedApi(await mw("/api/items")) &&
      refusedPage(await mw("/books", { cookie: "nope" })),
    "cookie path: a bad or missing cookie → 401 on /api, /login on a page",
  );
  assert(through(await mw("/charts")) && refusedApi(await mw("/api/charts")), "cookie path: the public chart pages are still public, their API still gated");
  setEnv({ BOOKS_APP_TOKEN: undefined });
  assert(through(await mw("/api/books/stats", { cookie })), "cookie path: works with BOOKS_APP_TOKEN unset");

  setEnv({ FEED_PASSWORD: undefined, BOOKS_APP_TOKEN: TOKEN });
  assert(
    through(await mw("/api/items")) && through(await mw("/books")) && through(await mw("/api/books/stats", { auth: "Bearer wrong" })),
    "FEED_PASSWORD unset → everything through, as before (local dev)",
  );

  const matcher = new RegExp(`^${(config.matcher as string[])[0]}$`);
  assert(
    matcher.test("/api/books") &&
      matcher.test("/api/books/stats") &&
      matcher.test(`/api/books/${BOOK_ID}/ask`) &&
      matcher.test(`/api/books/by-md5/${expected.partial_md5}`) &&
      !matcher.test("/api/hoops/import") &&
      !matcher.test("/kosync/k/healthcheck"),
    "🔴 /api/books is NOT exempted from the middleware — the bearer is checked there, so a bad one is the middleware's 401",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n3. the endpoints (real route handlers, throwaway database):");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "books-app-token-check-")));
const { ingestBook, getBook, replaceBookFile } = await import("../lib/books/store.ts");
const { createUser, putProgress } = await import("../lib/books/kosync.ts");
const { getBookHistory, getReadingStats } = await import("../lib/books/statsData.ts");
const { editEpub } = await import("../lib/books/epubEdit.ts");
const { PAGE_WORDS } = await import("../lib/books/pages.ts");
const byMd5Route = await import("../app/api/books/by-md5/[partialMd5]/route.ts");
const statsRoute = await import("../app/api/books/stats/route.ts");
const bookRoute = await import("../app/api/books/[id]/route.ts");
const toReadRoute = await import("../app/api/books/[id]/to-read/route.ts");
const coverRoute = await import("../app/api/books/[id]/cover/route.ts");
const askRoute = await import("../app/api/books/[id]/ask/route.ts");

const req = (url: string, init?: { method?: string; body?: unknown }) =>
  new NextRequest(`http://localhost${url}`, {
    method: init?.method ?? "GET",
    ...(init?.body !== undefined
      ? { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body), headers: { "content-type": "application/json" } }
      : {}),
  });
const byMd5 = async (key: string) => {
  const r = await byMd5Route.GET(req(`/api/books/by-md5/${key}`), { params: { partialMd5: key } });
  return { status: r.status, body: await r.json() };
};
const j = (v: unknown) => JSON.stringify(v);

/** `now`-dependent pairs computed a second apart can legitimately differ; retry across a second boundary. */
async function sameSecond(a: () => Promise<unknown>, b: () => unknown): Promise<boolean> {
  for (let i = 0; i < 3; i++) if (j(await a()) === j(b())) return true;
  return false;
}

// The contract's types. "?" = may be null. A value must be present with its
// type; fields the contract doesn't name are allowed (additions don't break a client).
type Shape = string | { [k: string]: Shape } | [Shape] | OrNull;
class OrNull {
  shape: Shape;
  constructor(shape: Shape) {
    this.shape = shape;
  }
}
const orNull = (shape: Shape) => new OrNull(shape);
function conforms(v: unknown, shape: Shape, at: string, errs: string[]): void {
  if (shape instanceof OrNull) {
    if (v !== null) conforms(v, shape.shape, at, errs);
    return;
  }
  if (typeof shape === "string") {
    const nullable = shape.endsWith("?");
    const base = nullable ? shape.slice(0, -1) : shape;
    if (v === null) {
      if (!nullable) errs.push(`${at}: null, contract says ${shape}`);
      return;
    }
    if (v === undefined) return void errs.push(`${at}: missing`);
    if (typeof v !== base) errs.push(`${at}: ${typeof v}, contract says ${shape}`);
    return;
  }
  if (Array.isArray(shape)) {
    if (!Array.isArray(v)) return void errs.push(`${at}: not an array`);
    v.forEach((x, i) => conforms(x, shape[0], `${at}[${i}]`, errs));
    return;
  }
  if (v === null || typeof v !== "object") return void errs.push(`${at}: not an object`);
  for (const [k, s] of Object.entries(shape)) {
    if (!(k in (v as object))) {
      errs.push(`${at}.${k}: missing`);
      continue;
    }
    conforms((v as Record<string, unknown>)[k], s, `${at}.${k}`, errs);
  }
}
function contract(v: unknown, shape: Shape, label: string): void {
  const errs: string[] = [];
  conforms(v, shape, "", errs);
  for (const e of errs.slice(0, 8)) console.error(`    ${e}`);
  assert(errs.length === 0, label);
}

const BOOK: Shape = {
  id: "string", title: "string", author: "string?", series: "string?", seriesIndex: "number?",
  language: "string?", description: "string?", fileName: "string", fileSize: "number",
  sha256: "string", partialMd5: "string", coverName: "string?", wordCount: "number?",
  toRead: "boolean", toReadAt: "string?", addedAt: "string", updatedAt: "string",
};
const SYNC: Shape = { progress: "string", percentage: "number", device: "string?", timestamp: "number" };
const HISTORY: Shape = {
  started: "boolean", daysRead: "number", pages: "number", firstSeen: "number?", lastRead: "number?",
  finishes: [{ finishedAt: "number", daysTaken: "number?" }],
  readingDaysToFinish: "number?", daysToFinish: "number?", pagesLeft: "number?", totalPages: "number?",
};
const STATS_BOOK: Shape = {
  id: "string", title: "string", author: "string?", series: "string?", seriesIndex: "number?",
  partialMd5: "string", wordCount: "number?", coverName: "string?",
};
const RATE: Shape = { perCalendarDay: "number", perReadingDay: "number", readingDays: "number", pages: "number", windowDays: "number" };
const STATS: Shape = {
  hasHistory: "boolean", since: "number?",
  today: { day: "string", pages: "number", syncs: "number", books: "number" },
  streak: { current: "number", longest: "number", bankedToday: "boolean", atRisk: "boolean" },
  calendar: [{ day: "string", pages: "number", syncs: "number", books: "number" }],
  rate: orNull(RATE),
  nowReading: [{
    book: orNull(STATS_BOOK), document: "string", percentage: "number", pagesRead: "number",
    pagesLeft: "number", lastReadAt: "number", daysIdle: "number", readingDaysToFinish: "number?",
    daysToFinish: "number?", stalled: "boolean",
  }],
  finished: [{ book: orNull(STATS_BOOK), document: "string", finishedAt: "number", day: "string", words: "number?", daysTaken: "number?" }],
  records: { bestDay: orNull({ day: "string", pages: "number" }), longestStreak: "number" },
  totals: {
    pages: "number", words: "number", booksFinished: "number", daysRead: "number",
    pagesThisYear: "number", booksFinishedThisYear: "number",
  },
  pace: { last7: "number", last30: "number", window: "number" },
  devices: [{ device: "string", pages: "number", syncs: "number" }],
  badges: [{ key: "string", name: "string", blurb: "string", earnedAt: "number?", progress: "number" }],
  unmeasured: { documents: "number", syncs: "number" },
};

const fixtureBytes = fixture("fixture.epub");
const { book } = ingestBook(fixtureBytes, "fixture.epub");
const alice = ingestBook(fixture("sheafs-alice.epub"), "alice.epub").book;
const OLD = expected.partial_md5 as string;
{
  const r = await byMd5(OLD);
  const m = expected.meta;
  assert(
    r.status === 200 &&
      r.body.book.id === book.id &&
      r.body.book.title === m.title &&
      r.body.book.author === m.author &&
      r.body.book.series === m.series &&
      r.body.book.seriesIndex === m.series_index,
    `🔴 the Python reference's partial MD5 for fixture.epub finds that book: "${m.title}" by ${m.author}, ${m.series} #${m.series_index}`,
  );
  assert(r.body.matchedAlias === false && j(r.body.aliases) === "[]" && r.body.sync === null, "a current key, no aliases, no sync yet");
  assert(r.body.history?.started === false, "an unopened book's history says so");
  contract(r.body, { book: BOOK, matchedAlias: "boolean", aliases: ["string"], sync: orNull(SYNC), history: HISTORY }, "the by-md5 response has every contract field, with its type (unsynced)");
  assert((await byMd5(OLD.toUpperCase())).body.book?.id === book.id, "the key is case-insensitive");
  assert(
    (await byMd5("not-a-key")).status === 400 && (await byMd5(OLD.slice(1))).status === 400 && (await byMd5(OLD + "0")).status === 400,
    "a malformed key → 400",
  );
  assert((await byMd5("0".repeat(32))).status === 404, "an unknown key → 404");
  assert((await byMd5(alice.partialMd5)).body.book?.id === alice.id, "another book's key finds that book, not this one");
}

// A device syncs, then the file is edited in place (a new title in the OPF).
const wire = createHash("md5").update("sync-password").digest("hex");
createUser("reader", wire);
const POINTER = "/body/DocFragment[1]/body/p[200]";
putProgress("reader", { document: OLD, progress: POINTER, percentage: 0.25, device: "Sheafs", device_id: "dev-1" });
const replaced = replaceBookFile(book.id, editEpub(fixtureBytes, { title: "The Fixture Book, Revised" }).bytes, {
  edit: { title: "The Fixture Book, Revised" },
});
const NEW = replaced.book.partialMd5;
{
  assert(NEW !== OLD, "the edit changed the file's key (the case this exists for)");
  const viaOld = await byMd5(OLD);
  const viaNew = await byMd5(NEW);
  assert(
    viaOld.status === 200 && viaOld.body.book.id === book.id && viaOld.body.book.partialMd5 === NEW && viaOld.body.matchedAlias === true,
    "🔴 the OLD key (a device still holding the pre-edit copy) finds the same book, through its alias",
  );
  assert(viaNew.body.book?.id === book.id && viaNew.body.matchedAlias === false, "the new key finds it directly");
  assert(j(viaOld.body.aliases) === j([OLD]) && j(viaNew.body.aliases) === j([OLD]), "the response lists the old key as an alias");
  assert(
    viaOld.body.sync?.progress === POINTER && viaOld.body.sync?.percentage === 0.25 && viaOld.body.sync?.device === "Sheafs",
    "the position followed the book to its new key, byte-exact",
  );
  assert(viaOld.body.book.title === "The Fixture Book, Revised", "and the book is the edited one");
  contract(viaOld.body, { book: BOOK, matchedAlias: "boolean", aliases: ["string"], sync: SYNC, history: HISTORY }, "the by-md5 response has every contract field, with its type (synced)");

  // The old-copy device reads on; its sync lands on the same book.
  putProgress("reader", { document: OLD, progress: "/body/DocFragment[1]/body/p[450]", percentage: 0.5, device: "Sheafs", device_id: "dev-1" });
  const after = await byMd5(OLD);
  assert(after.body.sync?.percentage === 0.5 && after.body.history?.started === true, "a sync through the old key moves the same position and starts the history");
  assert(
    await sameSecond(
      async () => (await byMd5(OLD)).body,
      () => {
        const b = getBook(book.id)!;
        const s = { progress: "/body/DocFragment[1]/body/p[450]", percentage: 0.5, device: "Sheafs" };
        return { book: b, matchedAlias: true, aliases: [OLD], sync: { ...s, timestamp: after.body.sync.timestamp }, history: getBookHistory(b.partialMd5) };
      },
    ),
    "the book and its history are exactly what the detail page is built from (getBook, getBookHistory)",
  );
}

// The endpoints that already existed, through their handlers.
{
  const put = await bookRoute.PUT(req(`/api/books/${book.id}`, { method: "PUT", body: { series: "Fixtures Revised", seriesIndex: 4.5, author: "" } }), { params: { id: book.id } });
  const putBody = await put.json();
  assert(
    put.status === 200 && putBody.book.series === "Fixtures Revised" && putBody.book.seriesIndex === 4.5 && putBody.book.author === null && putBody.book.title === "The Fixture Book, Revised",
    "PUT /api/books/{id}: fields sent change (\"\" clears to null), fields left out are kept",
  );
  contract(putBody, { book: BOOK }, "PUT /api/books/{id} answers { book }");
  assert(putBody.book.partialMd5 === NEW && putBody.book.sha256 === replaced.book.sha256, "a metadata edit leaves the sync key alone");
  const missing = await bookRoute.PUT(req("/api/books/nope", { method: "PUT", body: {} }), { params: { id: "nope" } });
  assert(missing.status === 404, "PUT on an unknown id → 404");

  const star = await toReadRoute.POST(req(`/api/books/${book.id}/to-read`, { method: "POST", body: { toRead: true } }), { params: { id: book.id } });
  const starBody = await star.json();
  assert(star.status === 200 && starBody.book.toRead === true && typeof starBody.book.toReadAt === "string", "POST to-read {toRead:true} → on the shelf");
  assert((await byMd5(OLD)).body.book.toRead === true, "the lookup shows the To Read state");
  const bad = await toReadRoute.POST(req(`/api/books/${book.id}/to-read`, { method: "POST", body: { toRead: "yes" } }), { params: { id: book.id } });
  assert(bad.status === 400, "to-read with a non-boolean → 400");

  const cover = await coverRoute.GET(req(`/api/books/${book.id}/cover`), { params: { id: book.id } });
  const png = Buffer.from(await cover.arrayBuffer());
  assert(
    cover.status === 200 && cover.headers.get("content-type") === "image/png" && png.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    "GET cover → the PNG the fixture carries (by its magic number)",
  );
  assert((await coverRoute.GET(req("/api/books/nope/cover"), { params: { id: "nope" } })).status === 404, "cover for an unknown id → 404");
}

{
  const statsRes = await statsRoute.GET();
  const body = await statsRes.json();
  assert(statsRes.status === 200 && body.pageWords === PAGE_WORDS && body.pageWords === 387 && body.timeZone === "America/Denver", "stats: pageWords 387 and America/Denver, the conventions the numbers are in");
  assert(
    await sameSecond(async () => (await (await statsRoute.GET()).json()).stats, () => getReadingStats()),
    "🔴 stats are exactly what /books/stats renders (getReadingStats)",
  );
  contract(body.stats, STATS, "the stats response has every contract field, with its type");
  const expectPages = Math.round((0.25 * expected.text.words) / PAGE_WORDS);
  assert(
    body.stats.totals.pages === expectPages && body.stats.today.pages === expectPages,
    `stats: the one quarter-book of reading is ${expectPages} pages — from the Python word count (${expected.text.words}) ÷ ${PAGE_WORDS}`,
  );
  assert(body.stats.nowReading[0]?.book?.id === book.id && body.stats.nowReading[0]?.document === NEW, "stats: now reading is the fixture, on its current key");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n4. ask over the wire (a fake Anthropic on localhost):");
{
  const ANSWER = ["The White ", "Rabbit, who ", "is late."];
  const server = http.createServer((rq, rs) => {
    let raw = "";
    rq.on("data", (c) => (raw += c));
    rq.on("end", () => {
      const sent = JSON.parse(raw || "{}");
      const question = sent.messages?.[sent.messages.length - 1]?.content ?? "";
      if (String(question).includes("FAIL")) {
        rs.writeHead(400, { "content-type": "application/json" });
        rs.end(j({ type: "error", error: { type: "invalid_request_error", message: "fake refusal" } }));
        return;
      }
      rs.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (type: string, data: object) => rs.write(`event: ${type}\ndata: ${j({ type, ...data })}\n\n`);
      ev("message_start", {
        message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } },
      });
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      for (const t of ANSWER) ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: t } });
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 9 } });
      ev("message_stop", {});
      rs.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  const p = { params: { id: alice.id } };
  const askGet = async () => (await askRoute.GET(req(`/api/books/${alice.id}/ask`), p)).json();
  const askPost = (body: unknown) => askRoute.POST(req(`/api/books/${alice.id}/ask`, { method: "POST", body }), p);
  async function ndjson(r: Response): Promise<Array<Record<string, unknown>>> {
    const text = await r.text();
    return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
  const ASK_GET: Shape = { turns: [{ id: "number", role: "string", content: "string", words: "number", createdAt: "number" }], pending: "boolean", configured: "boolean" };

  setEnv({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_BASE_URL: undefined });
  const g0 = await askGet();
  assert(g0.configured === false && typeof g0.unavailable === "string" && !("words" in g0) && j(g0.turns) === "[]", "GET ask, no sync and no key: configured false, `unavailable` says why, no `words`");
  contract(g0, ASK_GET, "GET ask has every contract field (unavailable form)");
  const noKey = await askPost({ question: "Who is late?" });
  assert(noKey.status === 503 && typeof (await noKey.json()).error === "string", "POST ask with ANTHROPIC_API_KEY unset → 503 { error }");

  setEnv({ ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` });
  assert((await askPost({ question: "Who is late?" })).status === 409, "POST ask with no synced position → 409");
  assert((await askPost({ question: "  " })).status === 400 && (await askPost({ question: "x".repeat(4001) })).status === 400, "an empty or over-4,000-character question → 400");
  assert((await askRoute.GET(req("/api/books/nope/ask"), { params: { id: "nope" } })).status === 404, "ask on an unknown id → 404");

  putProgress("reader", { document: alice.partialMd5, progress: "not-a-pointer", percentage: 0.5, device: "Sheafs", device_id: "dev-1" });
  const g1 = await askGet();
  assert(
    g1.configured === true && g1.pending === false && g1.words > 0 && g1.totalWords > g1.words && g1.percentage === 0.5 && g1.precision === "percentage",
    "GET ask once synced: words < totalWords, percentage, precision (an unreadable pointer falls back to the percentage)",
  );
  contract(g1, { ...(ASK_GET as object), words: "number", totalWords: "number", percentage: "number", precision: "string" }, "GET ask has every contract field (ready form)");

  const r = await askPost({ question: "Who is late?" });
  const events = await ndjson(r);
  const texts = events.filter((e) => e.t === "text");
  assert(r.status === 200 && (r.headers.get("content-type") ?? "").startsWith("application/x-ndjson"), "POST ask → 200 application/x-ndjson");
  assert(
    j(events[0]) === j({ t: "meta", words: g1.words, totalWords: g1.totalWords, percentage: 0.5 }),
    '🔴 the first event is {"t":"meta","words","totalWords","percentage"}',
  );
  assert(
    texts.length === ANSWER.length && texts.every((e) => typeof e.v === "string") && texts.map((e) => e.v).join("") === ANSWER.join(""),
    '🔴 then {"t":"text","v"} per delta, in order, adding up to the answer',
  );
  assert(j(events[events.length - 1]) === j({ t: "done" }) && events.length === ANSWER.length + 2, '🔴 and it ends {"t":"done"} — nothing else in between');
  const g2 = await askGet();
  assert(
    g2.turns.length === 2 && g2.turns[0].role === "user" && g2.turns[0].content === "Who is late?" && g2.turns[1].role === "assistant" && g2.turns[1].content === ANSWER.join(""),
    "the question and its answer are saved as the thread",
  );

  console.log("  (the BadRequestError logged next is the fake server's 400, on purpose)");
  const f = await askPost({ question: "FAIL this one" });
  const fe = await ndjson(f);
  assert(
    f.status === 200 && fe[0].t === "meta" && fe[fe.length - 1].t === "error" && typeof fe[fe.length - 1].v === "string" && !fe.some((e) => e.t === "done"),
    '🔴 an API error mid-ask: the stream (already 200) ends {"t":"error","v"}, never "done"',
  );
  assert((await askGet()).turns.length === 2, "and the failed question is not kept");

  const del = await askRoute.DELETE(req(`/api/books/${alice.id}/ask`, { method: "DELETE" }), p);
  assert(j(await del.json()) === j({ cleared: 2 }) && (await askGet()).turns.length === 0, "DELETE ask → { cleared: 2 }, the thread is empty");
  server.close();
  setEnv({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_BASE_URL: undefined });
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n5. static:");
{
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const tokenSrc = strip(source("lib/books/appToken.ts"));
  const mwSrc = strip(source("middleware.ts"));
  assert(!/^\s*import\s/m.test(tokenSrc) && !/require\(/.test(tokenSrc), "🔴 appToken.ts imports nothing (it runs on the edge runtime)");
  assert(!/["'](node:)?crypto["']/.test(mwSrc), "🔴 middleware.ts doesn't import Node's crypto (not on the edge runtime)");
  assert(
    /process\.env\.BOOKS_APP_TOKEN/.test(tokenSrc) && !/FEED_PASSWORD|BOOKS_API_KEY/.test(tokenSrc),
    "🔴 the token is BOOKS_APP_TOKEN alone — never FEED_PASSWORD, never BOOKS_API_KEY",
  );
  const cookieAt = mwSrc.indexOf("cookie?.value === expected");
  const tokenAt = mwSrc.indexOf("appTokenAllows(request.nextUrl.pathname");
  const deniedAt = mwSrc.indexOf('{ error: "Unauthorized" }');
  assert(cookieAt > 0 && tokenAt > cookieAt && deniedAt > tokenAt, "the middleware checks the token after the cookie and before the 401");
  assert(!/api\/books/.test((config.matcher as string[])[0]), "the matcher does not mention api/books");

  const statsRouteSrc = strip(source("app/api/books/stats/route.ts"));
  const statsPageSrc = strip(source("app/books/stats/page.tsx"));
  assert(
    /getReadingStats\(\)/.test(statsRouteSrc) && /getReadingStats\(\)/.test(statsPageSrc) && !/computeReadingStats/.test(statsRouteSrc),
    "🔴 the stats route makes the page's call and computes nothing of its own",
  );
  const byMd5Src = strip(source("app/api/books/by-md5/[partialMd5]/route.ts"));
  assert(/resolveDocument\(key\)/.test(byMd5Src), "🔴 by-md5 resolves the key through the alias table before looking the book up");

  // Every endpoint the contract lists exists, with that method.
  const doc = source("docs/books-app-api.md");
  const listed = [...doc.matchAll(/^#{2,4} `(GET|POST|PUT|DELETE) (\/api\/books[^`]*)`/gm)].map((m) => [m[1], m[2]] as const);
  let ok = listed.length >= 8;
  for (const [method, p] of listed) {
    const dir = p
      .replace(/\{partialMd5\}/g, "[partialMd5]")
      .replace(/\{id\}/g, "[id]")
      .replace(/\?.*$/, "");
    const file = path.join(repoRoot, "app", dir, "route.ts");
    const there = fs.existsSync(file) && new RegExp(`export async function ${method}\\b`).test(fs.readFileSync(file, "utf8"));
    if (!there) console.error(`    contract lists ${method} ${p}, but ${path.relative(repoRoot, file)} has no ${method}`);
    ok &&= there;
  }
  assert(ok, `every endpoint docs/books-app-api.md lists (${listed.length}) is a route with that method`);
}

if (failures > 0) {
  console.error(`\n✗ check:books:app-token — ${failures} failure${failures === 1 ? "" : "s"}`);
  process.exit(1);
}
console.log("\n✓ check:books:app-token — the app token opens /api/books/* and nothing else; the cookie path is unchanged");
