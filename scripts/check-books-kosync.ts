#!/usr/bin/env node
//
// 🔴 THE KOSYNC PROTOCOL GATE (BOOKS_PLAN §10).
//
//   npm run check:books:kosync     (standalone)
//   npm run build                  (via prebuild)
//
// Pins the semantics the devices depend on:
//   - the WIRE key is md5(password) and storage is hardened (sha256 at rest,
//     never the wire value verbatim)
//   - single-user registration policy (first create seeds; later names refused;
//     same-name re-register with the right key is idempotent)
//   - `progress` is OPAQUE: hostile strings round-trip byte-exact — the
//     assertion uses a REAL x-pointer shape (what CrossPoint pushes) plus a
//     hostile unicode/quote string, because "helpful" normalization here is
//     exactly the class of bug that made Stump's own app clobber positions
//   - a document with NO matching book still stores (sideloaded files sync)
//   - import never rolls back a newer device-written position
//
// Hermetic: temp cwd before first getDb().
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kosync-check-"));
process.chdir(tmp);

const { createUser, authUser, putProgress, getProgress, importProgress, userCount, setPassword, firstUsername } =
  await import("../lib/books/kosync.ts");
const { getDb } = await import("../lib/db.ts");

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}
const md5 = (s: string) => createHash("md5").update(s).digest("hex");

console.log("check:books:kosync — the protocol-semantics gate\n");

// ── registration policy ────────────────────────────────────────────────────
const wireKey = md5("stumpsync"); // what the device actually sends
assert(userCount() === 0, "starts empty");
assert(createUser("keith", wireKey) === "created", "first create seeds the account");
assert(createUser("mallory", md5("evil")) === "closed", "a second username is refused");
assert(createUser("keith", wireKey) === "created", "same user + right key re-registers idempotently");
assert(createUser("keith", md5("wrong")) === "exists", "same user + wrong key is refused");
assert(userCount() === 1, "exactly one user exists");

// ── wire vs at-rest ────────────────────────────────────────────────────────
const stored = (
  getDb().prepare(`SELECT key_hash FROM kosync_users WHERE username = 'keith'`).get() as {
    key_hash: string;
  }
).key_hash;
assert(stored !== wireKey, "the wire md5 is NOT stored verbatim (storage hardened)");
assert(stored === createHash("sha256").update(wireKey).digest("hex"), "at rest = sha256(wire)");
assert(authUser("keith", wireKey), "auth accepts the client-computed md5");
assert(!authUser("keith", "stumpsync"), "auth rejects the PLAINTEXT password (wire is md5)");
assert(!authUser("keith", md5("nope")), "auth rejects a wrong key");
assert(!authUser("nobody", wireKey), "auth rejects an unknown user");

// ── opaque progress round-trip ─────────────────────────────────────────────
// A real CrossPoint/Readest x-pointer (the richer Readest form with char
// offset), plus a hostile string. Byte-exact or bust.
const realPointer = "/body/DocFragment[7]/body/section/p[44]/text()[2].186";
const hostile = "p.42 — \"quoted\" & <tagged> 'stuff' 100%é书";
for (const [label, progress] of [
  ["a real x-pointer", realPointer],
  ["a hostile unicode/quote string", hostile],
] as const) {
  const doc = md5(label);
  // Twice: the first put exercises INSERT, the second the ON CONFLICT UPDATE
  // — both write paths must preserve the string byte-exact.
  putProgress("keith", { document: doc, progress: "placeholder", percentage: 0.1 });
  putProgress("keith", { document: doc, progress, percentage: 0.5, device: "CrossPoint", device_id: "crosspoint-reader" });
  const back = getProgress("keith", doc);
  assert(back?.progress === progress, `${label} round-trips byte-exact (through the upsert path)`);
}

// ── no-FK: sideloaded documents store fine ─────────────────────────────────
// (No books row exists in this temp DB at all — every put above already
// proves it, but make the intent explicit.)
const orphan = "ffffffffffffffffffffffffffffffff";
putProgress("keith", { document: orphan, progress: "/body/DocFragment[1]/body/p[1]", percentage: 0.01 });
assert(getProgress("keith", orphan) != null, "a document with no catalog book still syncs");
assert(getProgress("keith", "0000000000000000") == null, "unknown document reads as absent");

// ── import never rolls back the device ─────────────────────────────────────
const doc = md5("rollback-test");
putProgress("keith", { document: doc, progress: "newer-from-device", percentage: 0.9 });
const liveTs = getProgress("keith", doc)!.timestamp;
const r1 = importProgress("keith", [
  { document: doc, progress: "older-from-stump", percentage: 0.3, device: null, device_id: null, timestamp: liveTs - 1000 },
]);
assert(r1.skipped === 1 && getProgress("keith", doc)!.progress === "newer-from-device",
  "an older imported row cannot roll back a newer device position");
const r2 = importProgress("keith", [
  { document: doc, progress: "even-newer", percentage: 0.95, device: null, device_id: null, timestamp: liveTs + 1000 },
]);
assert(r2.imported === 1 && getProgress("keith", doc)!.progress === "even-newer",
  "a newer imported row does apply");

// ── password rotation (2026-10-22) ─────────────────────────────────────────
// The seed password must be replaceable without re-seeding: the old wire key
// dies, the new one lives, and the single-user policy is unchanged after.
const rotated = md5("a-new-sync-password");
assert(firstUsername() === "keith", "firstUsername names the seeded account");
assert(setPassword(rotated) === "keith", "setPassword rotates the single user and names it");
assert(!authUser("keith", wireKey), "the OLD wire key is refused after rotation");
assert(authUser("keith", rotated), "the NEW wire key is accepted after rotation");
assert(createUser("keith", wireKey) === "exists", "re-register with the OLD key is refused after rotation");
assert(createUser("keith", rotated) === "created", "re-register with the NEW key stays idempotent");
assert(createUser("mallory", rotated) === "closed", "rotation does not reopen registration");
assert(userCount() === 1, "still exactly one user after rotation");

fs.rmSync(tmp, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\ncheck:books:kosync FAILED — ${failures} assertion(s)`);
  process.exit(1);
}
console.log("\ncheck:books:kosync OK");
