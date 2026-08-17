// One-time cross-check: our partialMd5 vs the koreader_hash values Stump
// computed independently (Rust) for the same 13 files, which CrossPoint (C++)
// then matched in production. Passing means three implementations agree.
// Kept for re-runs until the stump teardown; not wired into prebuild (it needs
// ~/.stump/stump.db, which only exists on the Mini).
import { partialMd5 } from "../lib/books/partialMd5.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const db = path.join(os.homedir(), ".stump", "stump.db");
const out = execFileSync("sqlite3", [
  "-separator", "|",
  db,
  "SELECT koreader_hash, path FROM media ORDER BY path;",
]).toString().trim();

let pass = 0, fail = 0;
for (const line of out.split("\n")) {
  const i = line.indexOf("|");
  const hash = line.slice(0, i);
  const p = line.slice(i + 1);
  const mine = partialMd5(fs.readFileSync(p));
  if (mine === hash) pass++;
  else {
    fail++;
    console.log(`MISMATCH ${path.basename(p)}\n  stump: ${hash}\n  ours:  ${mine}`);
  }
}
console.log(`${pass}/${pass + fail} files match stump's stored koreader_hash`);
process.exit(fail ? 1 : 0);
