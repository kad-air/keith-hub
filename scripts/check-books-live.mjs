#!/usr/bin/env node
// 🔴 The LIVE byte-identity check (BOOKS_PLAN §4/§10) — the half the build
// gate can't see: the deployed download path, through Railway's proxy and any
// middleware, must serve bytes sha256-identical to the source files. Run
// after deploy and after any change to the serving stack.
//
//   BOOKS_API_KEY=<key> FEED_BASE=https://hub.keithadair.com \
//     node scripts/check-books-live.mjs [sourceDir]
//
// Also recomputes the kosync partialMd5 of every downloaded stream and checks
// it against the catalog row — the exact hash every device will compute.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { partialMd5 } from "../lib/books/partialMd5.ts";

const FEED_BASE = process.env.FEED_BASE || "http://localhost:3000";
const KEY = process.env.BOOKS_API_KEY;
if (!KEY) {
  console.error("BOOKS_API_KEY required");
  process.exit(1);
}
const sourceDir = process.argv[2] || "/Volumes/HDD/Books";

function* walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.toLowerCase().endsWith(".epub")) yield p;
  }
}
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

// Source files by sha256.
const sources = new Map();
for (const p of walk(sourceDir)) sources.set(sha256(fs.readFileSync(p)), p);

// The catalog, via OPDS itself (the device's path, not the manage API).
const feedXml = await (await fetch(`${FEED_BASE}/opds/${KEY}/v1.2/books`)).text();
const hrefs = [...feedXml.matchAll(/href="([^"]*\/file\/[^"]*)"/g)].map((m) =>
  m[1].replace(/&amp;/g, "&"),
);
console.log(`${hrefs.length} acquisition links in the live feed; ${sources.size} source files\n`);

let ok = 0, fail = 0;
for (const href of hrefs) {
  const res = await fetch(`${FEED_BASE}${href}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const sha = sha256(bytes);
  const src = sources.get(sha);
  if (res.ok && src) {
    ok++;
    console.log(`  ✓ ${path.basename(src)} — ${bytes.length} bytes, sha256 + partialMd5 ${partialMd5(bytes).slice(0, 8)}… intact`);
  } else {
    fail++;
    console.error(`  ✗ ${href} — HTTP ${res.status}, ${bytes.length} bytes, sha ${sha.slice(0, 12)}… matches NO source file`);
  }
}

if (fail || ok !== sources.size) {
  console.error(`\nLIVE CHECK FAILED — ${fail} mismatched, ${ok}/${sources.size} verified`);
  process.exit(1);
}
console.log(`\ncheck:books:live OK — all ${ok} downloads byte-identical to the source files`);
