import { createHash } from "crypto";
import { getDb } from "../db.ts";
import { recordReadingEvent } from "./readingEvents.ts";

// The KOReader sync (kosync) model — the vanilla protocol, deliberately NOT a
// vendor dialect (BOOKS_PLAN §0): CrossPoint and Readest both speak exactly
// this. Auth on every call is headers x-auth-user + x-auth-key, where the key
// is md5(password) computed CLIENT-side.
//
// 🔴 The WIRE value is md5 and cannot be changed — "hardening" it to something
// modern makes every client fail to authenticate. What we store at rest is
// ours: sha256 of the received md5, compared as hashes. Harden the storage,
// never the wire.
//
// 🔴 `progress` is OPAQUE. CrossPoint/KOReader send an EPUB x-pointer
// (/body/DocFragment[7]/body/section/p[44]/text()[2].186 — Readest's carry a
// char offset); PDF clients send a page number. Stored and returned untouched:
// no parsing, no normalizing, no trimming. Any interpretation here breaks
// cross-reader sync in a way that looks like a client bug. (This opacity is
// exactly what Stump got wrong from the other side — its own app couldn't
// consume the x-pointer and clobbered it; see ~/Stump/stump-issue-draft.md.)

export type KosyncProgress = {
  document: string;
  progress: string;
  percentage: number;
  device: string | null;
  device_id: string | null;
  timestamp: number;
};

function atRestHash(wireKey: string): string {
  return createHash("sha256").update(wireKey).digest("hex");
}

export function userCount(): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM kosync_users`).get() as { n: number };
  return row.n;
}

/**
 * Register a user. `wireKey` is the client-computed md5(password).
 * Single-user policy (BOOKS_PLAN §5): creation is open only while the table
 * is empty — the first device to connect seeds the account (or the migration
 * script does), and every later create for a NEW name is refused. Re-creating
 * the existing user with the right key is treated as success so a device
 * "register" retry is harmless.
 */
export function createUser(
  username: string,
  wireKey: string,
): "created" | "exists" | "closed" {
  const db = getDb();
  const existing = db
    .prepare(`SELECT key_hash FROM kosync_users WHERE username = ?`)
    .get(username) as { key_hash: string } | undefined;
  if (existing) {
    return existing.key_hash === atRestHash(wireKey) ? "created" : "exists";
  }
  if (userCount() > 0) return "closed";
  db.prepare(`INSERT INTO kosync_users (username, key_hash, created_at) VALUES (?, ?, ?)`).run(
    username,
    atRestHash(wireKey),
    new Date().toISOString(),
  );
  return "created";
}

/**
 * Rotate the single user's password. `wireKey` is md5(newPassword) — the same
 * wire value the devices will send from now on. Returns the username whose
 * key changed, or null when no device has ever registered (registration via
 * createUser stays the only seeding path; this never invents an account).
 * Every device keeps failing 401 until its stored password is updated — that
 * is the point (added for the 2026-10-22 Railway breach rotation, when the
 * sync password was still the seed default and nothing could change it).
 */
export function setPassword(wireKey: string): string | null {
  const username = firstUsername();
  if (!username) return null;
  getDb()
    .prepare(`UPDATE kosync_users SET key_hash = ? WHERE username = ?`)
    .run(atRestHash(wireKey), username);
  return username;
}

/**
 * The registered reader's username, or null before any device has registered.
 * Single-user by design (see createUser) — the hub's own writes (catch-up
 * positioning) go to this account, because it IS the account every device
 * syncs against.
 */
export function firstUsername(): string | null {
  const row = getDb()
    .prepare(`SELECT username FROM kosync_users ORDER BY created_at LIMIT 1`)
    .get() as { username: string } | undefined;
  return row?.username ?? null;
}

/** Validate the x-auth-user / x-auth-key header pair. */
export function authUser(username: string | null, wireKey: string | null): boolean {
  if (!username || !wireKey) return false;
  const row = getDb()
    .prepare(`SELECT key_hash FROM kosync_users WHERE username = ?`)
    .get(username) as { key_hash: string } | undefined;
  return row != null && row.key_hash === atRestHash(wireKey);
}

/**
 * The key a document's position is stored under. Usually the key itself; for
 * the OLD key of a book whose file was edited in place (replaceBookFile), the
 * book's current key — so a device still holding the old copy keeps reading
 * and writing the same position as one holding the new copy. One lookup: the
 * alias table is kept flat (see rekeyDocument).
 */
export function resolveDocument(document: string): string {
  const row = getDb()
    .prepare(`SELECT document FROM kosync_aliases WHERE alias = ?`)
    .get(document) as { document: string } | undefined;
  return row?.document ?? document;
}

/** Every key that resolves to `document` other than itself (oldest first). */
export function aliasesOf(document: string): string[] {
  return (
    getDb()
      .prepare(`SELECT alias FROM kosync_aliases WHERE document = ? ORDER BY created_at, alias`)
      .all(document) as Array<{ alias: string }>
  ).map((r) => r.alias);
}

/**
 * Move everything keyed on `from` to `to`, and make `from` an alias of `to`.
 * Called by replaceBookFile when a book's bytes change; the caller runs it
 * inside the same transaction as the books-row update.
 *
 *   - kosync_progress: the row moves to the new key. If one already exists
 *     there (only possible if a device synced the new file before this ran),
 *     the NEWER of the two wins — never roll a reader back.
 *   - reading_events: re-keyed, so the stats page and the book's history keep
 *     one continuous record (they join on books.partial_md5, which is about to
 *     become `to`). Only the key column changes; no event is added, removed or
 *     altered, which is what "append-only" protects.
 *   - kosync_aliases: anything that pointed at `from` now points at `to`; `to`
 *     stops being an alias if it was one (a restore to an earlier version);
 *     `from` → `to` is added. Flat after every call, never a self-alias.
 */
export function rekeyDocument(from: string, to: string): void {
  if (from === to) return;
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM kosync_progress WHERE document = ?`)
    .all(from) as Array<KosyncProgress & { username: string }>;
  for (const r of rows) {
    const there = db
      .prepare(`SELECT timestamp FROM kosync_progress WHERE username = ? AND document = ?`)
      .get(r.username, to) as { timestamp: number } | undefined;
    if (there && there.timestamp >= r.timestamp) {
      db.prepare(`DELETE FROM kosync_progress WHERE username = ? AND document = ?`).run(r.username, from);
    } else {
      db.prepare(`DELETE FROM kosync_progress WHERE username = ? AND document = ?`).run(r.username, to);
      db.prepare(`UPDATE kosync_progress SET document = ? WHERE username = ? AND document = ?`).run(
        to,
        r.username,
        from,
      );
    }
  }
  db.prepare(`UPDATE reading_events SET document = ? WHERE document = ?`).run(to, from);
  db.prepare(`DELETE FROM kosync_aliases WHERE alias = ?`).run(to);
  db.prepare(`UPDATE kosync_aliases SET document = ? WHERE document = ?`).run(to, from);
  db.prepare(
    `INSERT INTO kosync_aliases (alias, document, created_at) VALUES (?, ?, ?)
       ON CONFLICT (alias) DO UPDATE SET document = excluded.document`,
  ).run(from, to, new Date().toISOString());
}

/**
 * Store a device's position.
 *
 * 🔴 The device's key goes through resolveDocument first, and the response
 * echoes the key the DEVICE sent — a client that compares the echoed
 * document to its own hash must never see a key it doesn't know.
 */
export function putProgress(
  username: string,
  input: {
    document: string;
    progress: string;
    percentage: number;
    device?: string | null;
    device_id?: string | null;
  },
): { document: string; timestamp: number } {
  const timestamp = Math.floor(Date.now() / 1000);
  const db = getDb();
  const p = { ...input, document: resolveDocument(input.document) };

  // Read the outgoing position BEFORE the upsert destroys it — it is the only
  // thing that makes this sync interpretable as movement rather than a bare
  // coordinate, and one statement further down it no longer exists anywhere.
  const previous = db
    .prepare(`SELECT progress, percentage FROM kosync_progress WHERE username = ? AND document = ?`)
    .get(username, p.document) as { progress: string; percentage: number } | undefined;

  db.prepare(
    `INSERT INTO kosync_progress (username, document, progress, percentage, device, device_id, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (username, document) DO UPDATE SET
         progress = excluded.progress,
         percentage = excluded.percentage,
         device = excluded.device,
         device_id = excluded.device_id,
         timestamp = excluded.timestamp`,
  ).run(username, p.document, p.progress, p.percentage, p.device ?? null, p.device_id ?? null, timestamp);

  // 🔴 Statistics are DECORATION; the position is the product. Nothing in here
  // may cost the reader their place in a book, so the history write is
  // isolated behind a catch and the position above it is already durable. A
  // missing reading_events table, a locked DB, a schema that drifted — each
  // costs a number on a page and nothing else. check:books:stats falsifies
  // this by dropping the table and asserting the PUT still stores.
  try {
    recordReadingEvent(username, p, previous ?? null, timestamp);
  } catch (err) {
    console.error("[books] reading history not recorded (the sync itself is fine):", err);
  }

  return { document: input.document, timestamp };
}

/** A device's stored position — through resolveDocument, echoing the key it asked with. */
export function getProgress(username: string, document: string): KosyncProgress | null {
  const row = getDb()
    .prepare(
      `SELECT document, progress, percentage, device, device_id, timestamp
       FROM kosync_progress WHERE username = ? AND document = ?`,
    )
    .get(username, resolveDocument(document)) as KosyncProgress | undefined;
  return row ? { ...row, document } : null;
}

/** All progress rows for a user — the UI joins them to books on partial_md5. */
export function listProgress(username?: string): Array<KosyncProgress & { username: string }> {
  const db = getDb();
  return (
    username
      ? db
          .prepare(`SELECT * FROM kosync_progress WHERE username = ? ORDER BY timestamp DESC`)
          .all(username)
      : db.prepare(`SELECT * FROM kosync_progress ORDER BY timestamp DESC`).all()
  ) as Array<KosyncProgress & { username: string }>;
}

/**
 * Import a batch of progress rows (the Stump migration). Overwrites only when
 * the incoming row is NEWER than what's stored — a device that has already
 * synced against this server must not be rolled back by a re-run.
 */
export function importProgress(
  username: string,
  rows: KosyncProgress[],
): { imported: number; skipped: number } {
  const db = getDb();
  let imported = 0;
  let skipped = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      const r = { ...row, document: resolveDocument(row.document) };
      const existing = db
        .prepare(`SELECT timestamp FROM kosync_progress WHERE username = ? AND document = ?`)
        .get(username, r.document) as { timestamp: number } | undefined;
      if (existing && existing.timestamp >= r.timestamp) {
        skipped++;
        continue;
      }
      db.prepare(
        `INSERT INTO kosync_progress (username, document, progress, percentage, device, device_id, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (username, document) DO UPDATE SET
           progress = excluded.progress,
           percentage = excluded.percentage,
           device = excluded.device,
           device_id = excluded.device_id,
           timestamp = excluded.timestamp`,
      ).run(username, r.document, r.progress, r.percentage, r.device, r.device_id, r.timestamp);
      imported++;
    }
  });
  tx();
  return { imported, skipped };
}
