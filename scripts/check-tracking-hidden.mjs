#!/usr/bin/env node
/**
 * Gate for the hidden Tracking section (Stow replaced it).
 *
 *   node scripts/check-tracking-hidden.mjs                  # against localhost:3000
 *   FEED_BASE=https://hub.keithadair.com FEED_PASSWORD=… \
 *     node scripts/check-tracking-hidden.mjs                # against production
 *
 * Exits non-zero the moment any part of the section is reachable again.
 *
 * Two halves, deliberately:
 *
 *   A. STATIC — every module that imports `TRACKER_CONFIGS` must also read
 *      `TRACKERS_ENABLED`. This is the landmine pin: hiding the nav is easy to
 *      undo by accident by adding a new consumer (a widget, a cron, a search
 *      index) that iterates the configs without checking the flag. Runs with no
 *      server.
 *
 *   B. LIVE — asks a running instance for every tracker URL and requires a 404.
 *      This is the half that can't lie: it goes through the real middleware,
 *      the real route handlers, and the real build, so it also catches "the
 *      flag is false but the routes were somehow still served". Before the
 *      section was hidden these all returned 200, so the check is falsifiable
 *      by construction — flip TRACKERS_ENABLED back to true and it fails.
 *
 * Not wired into `prebuild` on purpose: half B needs a server, and a check that
 * quietly skips its own assertions when one isn't there is worse than no check.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const FEED_BASE = (process.env.FEED_BASE || "http://localhost:3000").replace(/\/$/, "");
const SLUGS = ["books", "games", "tv", "movies", "music"];

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
};

const failures = [];
function ok(msg) {
  console.log(`  ${c.green("✓")} ${msg}`);
}
function fail(msg) {
  failures.push(msg);
  console.log(`  ${c.red("✗")} ${msg}`);
}

// ── A. Static: no ungated consumer of TRACKER_CONFIGS ──────────────────────

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(entry)) out.push(p);
  }
  return out;
}

console.log(c.bold("\nA. TRACKER_CONFIGS consumers are all flag-gated"));

const FLAG_FILE = join(ROOT, "lib/tracker-config.ts");
const flagSrc = readFileSync(FLAG_FILE, "utf8");
if (/export const TRACKERS_ENABLED = false/.test(flagSrc)) {
  ok("TRACKERS_ENABLED is false in lib/tracker-config.ts");
} else if (/export const TRACKERS_ENABLED = true/.test(flagSrc)) {
  fail(
    "TRACKERS_ENABLED is true — the Tracking section is BACK ON. That may be " +
      "intentional; if so this whole check no longer applies and should be deleted.",
  );
} else {
  fail("TRACKERS_ENABLED not found in lib/tracker-config.ts (renamed or removed?)");
}

for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  if (rel === "lib/tracker-config.ts" || rel.startsWith("scripts/")) continue;
  const src = readFileSync(file, "utf8");
  if (!src.includes("TRACKER_CONFIGS")) continue;
  if (src.includes("TRACKERS_ENABLED")) {
    ok(`${rel} reads the flag`);
  } else {
    fail(
      `${rel} iterates TRACKER_CONFIGS without reading TRACKERS_ENABLED — ` +
        `that's a live tracker surface behind the hidden section.`,
    );
  }
}

// ── B. Live: every tracker URL 404s ────────────────────────────────────────

console.log(c.bold(`\nB. Tracker URLs are gone on ${FEED_BASE}`));

async function login() {
  const pwFlagIdx = process.argv.indexOf("--password");
  const pw = pwFlagIdx !== -1 ? process.argv[pwFlagIdx + 1] : process.env.FEED_PASSWORD || "";
  if (!pw) return null;
  const res = await fetch(`${FEED_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `password=${encodeURIComponent(pw)}`,
    redirect: "manual",
  });
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error(`login failed (HTTP ${res.status})`);
  return setCookie.split(";")[0];
}

let cookie;
try {
  cookie = await login();
} catch (err) {
  fail(`could not authenticate against ${FEED_BASE}: ${err.message}`);
}

const headers = cookie ? { cookie } : {};

async function status(path) {
  const res = await fetch(`${FEED_BASE}${path}`, { headers, redirect: "manual" });
  return res.status;
}

try {
  // Sanity first: the hub itself must still be up and reachable, or every 404
  // below would "pass" for the wrong reason (server down, or logged out).
  const home = await status("/");
  if (home === 200) {
    ok(`GET / → 200 (hub is up and authenticated)`);
  } else {
    fail(
      `GET / → ${home}, expected 200. ${
        home === 302 || home === 307
          ? "Not authenticated — set FEED_PASSWORD or pass --password."
          : "Is the server running?"
      } Aborting: the 404s below would be meaningless.`,
    );
    throw new Error("precondition failed");
  }

  for (const slug of SLUGS) {
    for (const path of [
      `/trackers/${slug}`,
      `/trackers/${slug}/some-item-id`,
      `/api/trackers/${slug}`,
    ]) {
      const s = await status(path);
      if (s === 404) ok(`${path} → 404`);
      else fail(`${path} → ${s}, expected 404 (this URL served content before the section was hidden)`);
    }
  }
} catch (err) {
  if (err.message !== "precondition failed") {
    fail(`live check could not run: ${err.message}`);
  }
}

// ── Verdict ────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.log(
    `\n${c.red(c.bold(`FAILED — ${failures.length} problem(s):`))}\n` +
      failures.map((f) => `  • ${f}`).join("\n") +
      "\n",
  );
  process.exit(1);
}
console.log(`\n${c.green(c.bold("PASS"))} — the Tracking section is hidden everywhere.\n`);
