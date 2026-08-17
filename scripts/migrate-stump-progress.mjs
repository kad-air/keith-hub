#!/usr/bin/env node
// Migrate live reading positions out of Stump into the hub (BOOKS_PLAN §5).
//
//   FEED_BASE=https://hub.keithadair.com node scripts/migrate-stump-progress.mjs \
//     --password <hub pw> --kosync-user keith --kosync-pass stumpsync [--dry-run]
//
// Reads ~/.stump/stump.db directly (read-only): for each media row with a
// koreader_hash, takes the LATEST reading_session by updated_at and carries
// over ONLY koreader_progress + end_percentage. end_locator is ignored on
// purpose — it is the Readium-locator position from Stump's own app, the
// format that caused the clobbering bug this migration escapes.
//
// Ends with the migration's own check (BOOKS_PLAN §10): every migrated
// document hash must resolve to a book in the hub catalog via partial_md5.
// A miss means a file was not copied byte-for-byte — the silent sync-killer.
// Exits non-zero on any miss.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

const FEED_BASE = process.env.FEED_BASE || "http://localhost:3000";
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const dryRun = args.includes("--dry-run");
const hubPassword = opt("password", process.env.FEED_PASSWORD);
const kosyncUser = opt("kosync-user", "keith");
const kosyncPass = opt("kosync-pass", "stumpsync");
const wireKey = createHash("md5").update(kosyncPass).digest("hex");

// ── pull from stump.db ──────────────────────────────────────────────────────
// STUMP_DB overrides for running against a quiesced .backup copy — the live
// db can refuse read-only opens while the stump server holds it.
const db = process.env.STUMP_DB || path.join(os.homedir(), ".stump", "stump.db");
const sql = `
  SELECT m.koreader_hash, m.name, rs.koreader_progress, rs.end_percentage,
         COALESCE(rs.updated_at, rs.created_at), rs.device_ids
  FROM reading_sessions rs
  JOIN media m ON m.id = rs.media_id
  WHERE m.koreader_hash IS NOT NULL AND m.koreader_hash != ''
    AND rs.koreader_progress IS NOT NULL AND rs.koreader_progress != ''
  ORDER BY COALESCE(rs.updated_at, rs.created_at) ASC;
`;
const out = execFileSync("sqlite3", ["-separator", "", `file:${db}?immutable=1`, sql])
  .toString()
  .trim();

// Latest row per hash wins (input is sorted ascending, so later overwrites).
const byHash = new Map();
for (const line of out ? out.split("\n") : []) {
  const [hash, name, progress, pct, updatedAt, deviceIds] = line.split("");
  let device = "stump-migration";
  try {
    const ids = JSON.parse(deviceIds ?? "[]");
    if (Array.isArray(ids) && ids.length > 0) device = String(ids[ids.length - 1]);
  } catch {}
  byHash.set(hash, {
    name,
    row: {
      document: hash,
      progress,
      percentage: Number(pct),
      device,
      device_id: device,
      timestamp: Math.floor(new Date(updatedAt + "Z").getTime() / 1000) || Math.floor(Date.now() / 1000),
    },
  });
}

console.log(`${byHash.size} positions to migrate (latest per document):`);
for (const { name, row } of byHash.values()) {
  console.log(`  ${(row.percentage * 100).toFixed(1).padStart(5)}%  ${name}  ${row.progress.slice(0, 50)}`);
}
if (dryRun) process.exit(0);

// ── push to the hub ─────────────────────────────────────────────────────────
async function login() {
  if (!hubPassword) return null;
  const res = await fetch(`${FEED_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `password=${encodeURIComponent(hubPassword)}`,
    redirect: "manual",
  });
  const cookie = res.headers.get("set-cookie");
  if (!cookie) throw new Error(`hub login failed: HTTP ${res.status}`);
  return cookie.split(";")[0];
}
const cookie = await login();
const headers = { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) };

const res = await fetch(`${FEED_BASE}/api/books/kosync-import`, {
  method: "POST",
  headers,
  body: JSON.stringify({ username: kosyncUser, wireKey, rows: [...byHash.values()].map((v) => v.row) }),
});
const body = await res.json();
if (!res.ok) {
  console.error(`import failed: HTTP ${res.status}`, body);
  process.exit(1);
}
console.log(`\nimported: ${body.imported}, skipped (server newer): ${body.skipped}, user: ${body.user}`);

// ── the check: every hash resolves to a catalog book ───────────────────────
const cat = await (await fetch(`${FEED_BASE}/api/books`, { headers })).json();
const catalogHashes = new Set(cat.books.map((b) => b.partialMd5));
let missing = 0;
for (const [hash, { name }] of byHash) {
  if (!catalogHashes.has(hash)) {
    missing++;
    console.error(`  ✗ MISSING from catalog: ${name} (${hash}) — file not copied byte-for-byte?`);
  }
}
if (missing) {
  console.error(`\nMIGRATION CHECK FAILED — ${missing} position(s) point at no catalog book`);
  process.exit(1);
}
console.log(`migration check OK — all ${byHash.size} positions resolve to catalog books`);
