#!/usr/bin/env node
// Push every epub under a directory to the hub's upload endpoint. Dedupe is
// server-side by content hash, so re-runs are idempotent — a book already in
// the catalog reports created: false and nothing changes.
//
//   FEED_BASE=https://hub.keithadair.com node scripts/push-books.mjs [dir] --password <pw>
//   node scripts/push-books.mjs                      # local dev, /Volumes/HDD/Books
//
// 🔴 Files are sent byte-for-byte (BOOKS_PLAN §4): the kosync progress already
// attached to these bytes (via ~/.stump migration) only reattaches if the
// hashes match, and check:books:migration asserts that they did.
import fs from "node:fs";
import path from "node:path";

const FEED_BASE = process.env.FEED_BASE || "http://localhost:3000";
const args = process.argv.slice(2);
const pwIdx = args.indexOf("--password");
const password = pwIdx >= 0 ? args[pwIdx + 1] : process.env.FEED_PASSWORD;
const dir = args.find((a, i) => !a.startsWith("--") && i !== pwIdx + 1) || "/Volumes/HDD/Books";

function* walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.toLowerCase().endsWith(".epub")) yield p;
  }
}

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

const cookie = await login();
const files = [...walk(dir)];
console.log(`${files.length} epubs under ${dir} → ${FEED_BASE}`);

let created = 0, existing = 0, failed = 0;
for (const p of files) {
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(p)]), path.basename(p));
  const res = await fetch(`${FEED_BASE}/api/books/upload`, {
    method: "POST",
    headers: cookie ? { Cookie: cookie } : {},
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  const r = body.results?.[0];
  if (!res.ok || !r || r.error) {
    failed++;
    console.log(`  ✗ ${path.basename(p)} — HTTP ${res.status} ${r?.error ?? JSON.stringify(body)}`);
  } else {
    r.created ? created++ : existing++;
    console.log(`  ${r.created ? "＋" : "＝"} ${r.title}`);
  }
}
console.log(`done: ${created} created, ${existing} already present, ${failed} failed`);
process.exit(failed ? 1 : 0);
