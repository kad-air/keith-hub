#!/usr/bin/env node
// Edit a book's FILE on the hub — the cover and the title/author/series a
// reader shows once it's on the device — without losing anyone's place.
// The server does the work (POST /api/books/[id]/edit-file and friends; see
// lib/books/epubEdit.ts and replaceBookFile in lib/books/store.ts): the old
// file is archived, reading progress moves to the new file's sync key, and
// the old key keeps resolving, so a device still holding the old copy syncs
// the same position until it re-downloads.
//
//   FEED_BASE=https://hub.keithadair.com FEED_PASSWORD=… node scripts/edit-book.mjs <command>
//
//   find <text>                         books whose title/author/series match (id, title, author)
//   show <id>                           the row, its versions and old sync keys
//   edit <id> [--title T] [--author A] [--series S | --no-series] [--index N] [--cover img]
//   replace <id> <file.epub> [--metadata-from-file]
//                                       swap in a file edited elsewhere (Calibre, Sigil)
//   restore <id> <sha256>               put an archived version back (see `show`)
//   download <id> <out.epub>            the current file, byte-exact
//
// <id> may be a unique prefix. --password <pw> works in place of FEED_PASSWORD.
// Nothing here touches a device; devices pick the change up on their own
// (re-download from the catalog; Sheafs offers "Update" for books it got there).
import fs from "node:fs";
import path from "node:path";

const FEED_BASE = (process.env.FEED_BASE || "http://localhost:3000").replace(/\/$/, "");
const argv = process.argv.slice(2);

function takeFlag(name, hasValue = true) {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = hasValue ? argv[i + 1] : true;
  argv.splice(i, hasValue ? 2 : 1);
  return v;
}

const password = takeFlag("--password") ?? process.env.FEED_PASSWORD;

async function login() {
  if (!password) return null; // local dev with auth bypassed
  const res = await fetch(`${FEED_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `password=${encodeURIComponent(password)}`,
    redirect: "manual",
  });
  const cookie = res.headers.get("set-cookie");
  if (!cookie) throw new Error(`login failed: HTTP ${res.status}`);
  return cookie.split(";")[0];
}

let cookie;
async function api(p, init = {}) {
  cookie ??= await login();
  const res = await fetch(`${FEED_BASE}${p}`, {
    ...init,
    headers: { ...(init.headers ?? {}), ...(cookie ? { Cookie: cookie } : {}) },
    redirect: "manual",
  });
  if (res.status >= 300 && res.status < 400) throw new Error(`HTTP ${res.status} — not logged in? (set FEED_PASSWORD)`);
  return res;
}
async function json(p, init) {
  const res = await api(p, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${p}: HTTP ${res.status} ${body.code ? `[${body.code}] ` : ""}${body.error ?? ""}`);
  return body;
}

async function allBooks() {
  return (await json("/api/books")).books ?? [];
}

async function resolveId(prefix) {
  if (!prefix) throw new Error("missing <id>");
  const hits = (await allBooks()).filter((b) => b.id.startsWith(prefix));
  if (hits.length === 1) return hits[0].id;
  throw new Error(hits.length ? `"${prefix}" matches ${hits.length} books` : `no book id starts with "${prefix}"`);
}

function line(b) {
  return `${b.id}  ${b.title}${b.author ? ` — ${b.author}` : ""}${b.series ? `  [${b.series}${b.seriesIndex != null ? ` #${b.seriesIndex}` : ""}]` : ""}`;
}

function report(r) {
  console.log(`✓ ${line(r.book)}`);
  console.log(`  sync key ${r.previous.partialMd5} → ${r.book.partialMd5} (old key now resolves to the new one)`);
  if (r.changed) console.log(`  changed in the epub: ${r.changed.join(", ")}`);
  if (r.textChanged === true) {
    console.log("  ⚠ the chapter text differs from the old file: progress carried over, but a position may land near, not on, the same sentence");
  } else if (r.textChanged === false) {
    console.log("  chapters byte-identical: every saved position is exact in both copies");
  }
  console.log(`  undo: node scripts/edit-book.mjs restore ${r.book.id} ${r.previous.sha256}`);
}

const [cmd, ...rest] = argv;
try {
  if (cmd === "find") {
    const q = rest.join(" ").toLowerCase();
    for (const b of await allBooks()) {
      if ([b.title, b.author, b.series].some((s) => s && s.toLowerCase().includes(q))) console.log(line(b));
    }
  } else if (cmd === "show") {
    const id = await resolveId(rest[0]);
    const { book } = await json(`/api/books/${id}`);
    const v = await json(`/api/books/${id}/versions`);
    console.log(line(book));
    console.log(`  file ${book.fileName} · ${book.fileSize} bytes · sha256 ${book.sha256}`);
    console.log(`  sync key ${book.partialMd5}${v.aliases.length ? ` (also answers for ${v.aliases.join(", ")})` : ""}`);
    console.log(`  updated ${book.updatedAt}`);
    for (const x of v.versions) console.log(`  version ${x.sha256} · ${x.size} bytes · archived ${x.archivedAt}`);
  } else if (cmd === "edit") {
    const id = await resolveId(rest[0]);
    const form = new FormData();
    const title = takeFlag("--title");
    const author = takeFlag("--author");
    const series = takeFlag("--series");
    const noSeries = takeFlag("--no-series", false);
    const index = takeFlag("--index");
    const cover = takeFlag("--cover");
    if (title) form.set("title", title);
    if (author) form.set("author", author);
    if (noSeries) form.set("series", "");
    else if (series) form.set("series", series);
    if (index != null) form.set("seriesIndex", index);
    if (cover) form.set("cover", new Blob([fs.readFileSync(cover)]), path.basename(cover));
    if ([...form.keys()].length === 0) throw new Error("nothing to change: --title, --author, --series, --no-series, --index, --cover");
    report(await json(`/api/books/${id}/edit-file`, { method: "POST", body: form }));
  } else if (cmd === "replace") {
    const id = await resolveId(rest[0]);
    const file = rest[1];
    if (!file) throw new Error("missing <file.epub>");
    const form = new FormData();
    form.set("file", new Blob([fs.readFileSync(file)]), path.basename(file));
    if (takeFlag("--metadata-from-file", false) || rest.includes("--metadata-from-file")) form.set("metadata", "file");
    report(await json(`/api/books/${id}/replace-file`, { method: "POST", body: form }));
  } else if (cmd === "restore") {
    const id = await resolveId(rest[0]);
    report(
      await json(`/api/books/${id}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sha256: rest[1] }),
      }),
    );
  } else if (cmd === "download") {
    const id = await resolveId(rest[0]);
    if (!rest[1]) throw new Error("missing <out.epub>");
    const res = await api(`/api/books/${id}/file`);
    if (!res.ok) throw new Error(`download: HTTP ${res.status}`);
    fs.writeFileSync(rest[1], Buffer.from(await res.arrayBuffer()));
    console.log(`✓ wrote ${rest[1]}`);
  } else {
    console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 22).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
}
