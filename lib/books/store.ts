import { createHash, randomUUID } from "crypto";
import fs from "fs";
import path from "path";
// Relative + explicit .ts (not the "@/" alias) so plain node can execute the
// check scripts against the REAL module — the hoops-lib convention, see
// CLAUDE.md "Relative imports inside lib/hoops/". Webpack accepts both.
import { getDb } from "../db.ts";
import { partialMd5 } from "./partialMd5.ts";
import { extractEpubMeta } from "./epubMeta.ts";
import { countEpubWords } from "./epubText.ts";
import { normalizeMeta } from "./normalize.ts";
import { checkEpubHealth } from "./health.ts";
import { rekeyDocument } from "./kosync.ts";
import { openEpub, spinePaths } from "./epubEdit.ts";

// File storage: data/books/<id>/book.epub (+ cover.<ext>, + versions/<sha256>.epub
// for every file a book has replaced). One directory per book id — ids are
// stable under metadata edits AND file replacements, unlike titles.
//
// 🔴 The stored epub is never rewritten in passing (BOOKS_PLAN §4). The kosync
// document key is a partial MD5 of the bytes every device computes
// independently; a rewrite (metadata edit, "optimization", re-compression)
// silently detaches progress on every device at once. Metadata edits touch
// only the DB row. There is exactly ONE path that changes a book's bytes —
// replaceBookFile, below — and it exists to do the rekeying such a change
// needs: progress moves to the new key and the old key becomes an alias of
// it, so devices holding either copy keep syncing one position.

export type Book = {
  id: string;
  title: string;
  author: string | null;
  series: string | null;
  seriesIndex: number | null;
  language: string | null;
  description: string | null;
  fileName: string;
  fileSize: number;
  sha256: string;
  partialMd5: string;
  coverName: string | null;
  /** Words of prose in the epub — the denominator for every page figure on
   *  the reading-stats page. null when never computed, 0 when the file
   *  yielded no readable text. See lib/books/epubText.ts. */
  wordCount: number | null;
  /** On the "To Read" shelf — a short OPDS feed the X3 can reach without
   *  scrolling the whole catalog (it has no search). */
  toRead: boolean;
  /** When it was put on the shelf; orders the feed newest-first. */
  toReadAt: string | null;
  addedAt: string;
  updatedAt: string;
};

type BookRow = {
  id: string;
  title: string;
  author: string | null;
  series: string | null;
  series_index: number | null;
  language: string | null;
  description: string | null;
  file_name: string;
  file_size: number;
  sha256: string;
  partial_md5: string;
  cover_name: string | null;
  word_count: number | null;
  to_read: number;
  to_read_at: string | null;
  added_at: string;
  updated_at: string;
};

function rowToBook(row: BookRow): Book {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    series: row.series,
    seriesIndex: row.series_index,
    language: row.language,
    description: row.description,
    fileName: row.file_name,
    fileSize: row.file_size,
    sha256: row.sha256,
    partialMd5: row.partial_md5,
    coverName: row.cover_name,
    wordCount: row.word_count,
    toRead: row.to_read === 1,
    toReadAt: row.to_read_at,
    addedAt: row.added_at,
    updatedAt: row.updated_at,
  };
}

export function booksDir(): string {
  return path.join(process.cwd(), "data", "books");
}

export function bookFilePath(book: Pick<Book, "id">): string {
  return path.join(booksDir(), book.id, "book.epub");
}

export function bookCoverPath(book: Pick<Book, "id"> & { coverName: string }): string {
  return path.join(booksDir(), book.id, book.coverName);
}

export function listBooks(): Book[] {
  const rows = getDb()
    .prepare(`SELECT * FROM books ORDER BY author ASC, series ASC, series_index ASC, title ASC`)
    .all() as BookRow[];
  return rows.map(rowToBook);
}

export function getBook(id: string): Book | null {
  const row = getDb().prepare(`SELECT * FROM books WHERE id = ?`).get(id) as BookRow | undefined;
  return row ? rowToBook(row) : null;
}

export function getBookByPartialMd5(hash: string): Book | null {
  const row = getDb().prepare(`SELECT * FROM books WHERE partial_md5 = ?`).get(hash) as
    | BookRow
    | undefined;
  return row ? rowToBook(row) : null;
}

export type IngestResult = { book: Book; created: boolean };

/**
 * Ingest an epub from raw bytes. Content-addressed dedupe: the same bytes
 * uploaded twice return the existing row (same sha256 → same partial_md5 →
 * same progress identity; forking the row would fork nothing real).
 * Metadata extraction failing never fails the ingest — the file name stands
 * in as the title and the UI edits from there (BOOKS_PLAN §8).
 */
export function ingestBook(bytes: Buffer, fileName: string): IngestResult {
  const db = getDb();
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const existing = db.prepare(`SELECT * FROM books WHERE sha256 = ?`).get(sha256) as
    | BookRow
    | undefined;
  if (existing) return { book: rowToBook(existing), created: false };

  const raw = extractEpubMeta(bytes);
  const existingAuthors = (
    db.prepare(`SELECT DISTINCT author FROM books WHERE author IS NOT NULL`).all() as Array<{
      author: string;
    }>
  ).map((r) => r.author);
  const fallbackTitle = fileName.replace(/\.epub$/i, "").replace(/^\d+\s*-\s*/, "");
  const meta = normalizeMeta(raw, fallbackTitle, existingAuthors);

  const id = randomUUID();
  const now = new Date().toISOString();
  const dir = path.join(booksDir(), id);
  fs.mkdirSync(dir, { recursive: true });
  // Write-then-rename so a crash mid-write can't leave a half epub at the
  // path the download route serves.
  const tmp = path.join(dir, "book.epub.tmp");
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, path.join(dir, "book.epub"));

  let coverName: string | null = null;
  if (raw.cover) {
    coverName = `cover.${raw.cover.ext}`;
    fs.writeFileSync(path.join(dir, coverName), raw.cover.bytes);
  }

  // Length, for the stats page's page counts. A read of the bytes we already
  // hold in memory — never a rewrite, so the sync key is untouched. Failure
  // stores 0 rather than null so the backfill doesn't re-unzip a broken file
  // on every stats load; like metadata extraction, it can never fail an
  // ingest (BOOKS_PLAN §8).
  const wordCount = countEpubWords(bytes) ?? 0;

  // File health at ingest, while the bytes are already in hand. Failure is
  // benign like metadata and word count — healthData.ts rebuilds a missing
  // report lazily from the stored file, so nothing here may fail the ingest
  // (BOOKS_PLAN §8).
  let healthJson: string | null = null;
  try {
    healthJson = JSON.stringify({ ...checkEpubHealth(bytes), checkedAt: now });
  } catch {
    healthJson = null;
  }

  try {
    db.prepare(
      `INSERT INTO books (id, title, author, series, series_index, language, description,
                          file_name, file_size, sha256, partial_md5, cover_name, word_count,
                          health_json, added_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      meta.title,
      meta.author,
      meta.series,
      meta.seriesIndex,
      raw.language,
      raw.description,
      fileName,
      bytes.length,
      sha256,
      partialMd5(bytes),
      coverName,
      wordCount,
      healthJson,
      now,
      now,
    );
  } catch (err) {
    // Roll the files back so a failed insert doesn't strand bytes on the volume.
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }

  return { book: getBook(id)!, created: true };
}

/**
 * Fill word_count for books ingested before the column existed, by re-reading
 * their stored epubs. Idempotent and self-limiting: only rows with NULL are
 * touched, and a file that yields nothing records 0 so it is never retried.
 *
 * 🔴 Read-only with respect to the volume. It opens each epub, counts, and
 * writes a DB column — the bytes, the sha256 and the partial_md5 are never
 * touched, which is the same guarantee metadata edits carry (BOOKS_PLAN §4,
 * check:books:metadata). A book being read on a device right now can be
 * backfilled without disturbing it.
 *
 * Returns the number of rows filled.
 */
export function backfillWordCounts(limit = 500): number {
  const db = getDb();
  const rows = db
    .prepare(`SELECT id FROM books WHERE word_count IS NULL LIMIT ?`)
    .all(limit) as Array<{ id: string }>;
  if (rows.length === 0) return 0;

  const update = db.prepare(`UPDATE books SET word_count = ? WHERE id = ?`);
  let filled = 0;
  for (const { id } of rows) {
    let words = 0;
    try {
      words = countEpubWords(fs.readFileSync(path.join(booksDir(), id, "book.epub"))) ?? 0;
    } catch {
      // A missing or unreadable file records 0 and moves on — one broken book
      // must not stop the stats page from rendering the rest.
      words = 0;
    }
    update.run(words, id);
    filled++;
  }
  return filled;
}

/** Books on the "To Read" shelf, newest decision first — the order the OPDS
 *  feed uses, so the thing you most recently chose is the first thing the
 *  device shows you. */
export function listToRead(): Book[] {
  const rows = getDb()
    .prepare(`SELECT * FROM books WHERE to_read = 1 ORDER BY to_read_at DESC, title ASC`)
    .all() as BookRow[];
  return rows.map(rowToBook);
}

/**
 * Put a book on the To Read shelf, or take it off.
 *
 * 🔴 A DB-column write and nothing more — it never opens, rewrites or touches
 * the stored epub, so sha256 and partial_md5 (the kosync sync key) are
 * untouched and flagging a book you are currently reading cannot lose your
 * place. Same guarantee as a metadata edit; check:books:opds asserts it here
 * too, because this is a SECOND write path into the books table and the first
 * one's gate says nothing about it.
 *
 * Clearing the flag nulls to_read_at, so re-adding a book later puts it back
 * at the top of the shelf rather than wherever it sat before.
 */
export function setToRead(id: string, toRead: boolean): Book | null {
  const db = getDb();
  if (!getBook(id)) return null;
  db.prepare(`UPDATE books SET to_read = ?, to_read_at = ? WHERE id = ?`).run(
    toRead ? 1 : 0,
    toRead ? new Date().toISOString() : null,
    id,
  );
  return getBook(id);
}

export type BookEdit = Partial<
  Pick<Book, "title" | "author" | "series" | "seriesIndex" | "language" | "description">
>;

export function updateBook(id: string, edit: BookEdit): Book | null {
  const book = getBook(id);
  if (!book) return null;
  const next = { ...book, ...edit };
  getDb()
    .prepare(
      `UPDATE books SET title = ?, author = ?, series = ?, series_index = ?,
              language = ?, description = ?, updated_at = ? WHERE id = ?`,
    )
    .run(
      next.title,
      next.author,
      next.series,
      next.seriesIndex,
      next.language,
      next.description,
      new Date().toISOString(),
      id,
    );
  return getBook(id);
}

export type ReplaceErrorCode = "not-found" | "same-file" | "duplicate" | "no-version";

export class ReplaceError extends Error {
  // No TS parameter properties: the gates run under node's type stripping.
  code: ReplaceErrorCode;
  constructor(code: ReplaceErrorCode, message: string) {
    super(message);
    this.name = "ReplaceError";
    this.code = code;
  }
}

export type ReplaceResult = {
  book: Book;
  previous: { sha256: string; partialMd5: string };
  /** false when every spine document is byte-identical — positions are then
   *  exact on both copies. true means the TEXT changed (a different edition,
   *  a re-flowed chapter): progress still carries, but an x-pointer from the
   *  old copy may land near, not on, the same sentence. null = couldn't tell. */
  textChanged: boolean | null;
};

/** sha256 over the spine (paths + each document's bytes) — what an x-pointer depends on. */
function spineFingerprint(bytes: Buffer): string | null {
  try {
    const { entries, opf, opfPath } = openEpub(bytes);
    const h = createHash("sha256");
    for (const p of spinePaths(opf, opfPath)) {
      h.update(p).update("\0");
      const e = entries.find((x) => x.name === p);
      h.update(e ? e.data : Buffer.from("<missing>")).update("\0");
    }
    return h.digest("hex");
  } catch {
    return null;
  }
}

function versionsDir(id: string): string {
  return path.join(booksDir(), id, "versions");
}

/**
 * Swap a book's file for new bytes WITHOUT losing anyone's place — the one
 * path that changes a stored epub (see the header). Same book id, so the
 * OPDS entry, the To Read flag and the hub's history all stay put.
 *
 *  1. the current file is archived to versions/<sha256>.epub (restoreVersion
 *     puts it back — every replacement is reversible)
 *  2. the new bytes go in by write-then-rename
 *  3. ONE transaction: the books row (sha256, partial_md5, size, cover, word
 *     count, health, updated_at) and rekeyDocument(old key → new key), so
 *     progress, reading history and every older alias move together
 *  4. a DB failure puts the old file back
 *
 * Metadata: by default the DB row's title/author/series are KEPT (they may
 * carry edits made in the UI); `edit` overlays new values (the edit-file
 * path, where the OPF and the row change together); `metadataFromFile`
 * re-reads them from the new OPF instead.
 *
 * The caller is responsible for the bytes being a clean epub (the routes run
 * prepareForIngest or produce them with epubEdit).
 */
export function replaceBookFile(
  id: string,
  bytes: Buffer,
  opts: { edit?: BookEdit; metadataFromFile?: boolean } = {},
): ReplaceResult {
  const db = getDb();
  const book = getBook(id);
  if (!book) throw new ReplaceError("not-found", "no such book");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 === book.sha256) throw new ReplaceError("same-file", "the new file is identical to the current one");
  const key = partialMd5(bytes);
  const clash = db
    .prepare(`SELECT id, title FROM books WHERE (sha256 = ? OR partial_md5 = ?) AND id != ?`)
    .get(sha256, key, id) as { id: string; title: string } | undefined;
  if (clash) {
    throw new ReplaceError("duplicate", `those bytes are already another book ("${clash.title}")`);
  }

  const dir = path.join(booksDir(), id);
  const current = bookFilePath(book);
  const oldBytes = fs.existsSync(current) ? fs.readFileSync(current) : null;
  fs.mkdirSync(versionsDir(id), { recursive: true });
  const archived = path.join(versionsDir(id), `${book.sha256}.epub`);
  if (oldBytes && !fs.existsSync(archived)) fs.writeFileSync(archived, oldBytes);

  const textChanged = (() => {
    if (!oldBytes) return null;
    const a = spineFingerprint(oldBytes);
    const b = spineFingerprint(bytes);
    return a && b ? a !== b : null;
  })();

  const tmp = path.join(dir, "book.epub.tmp");
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, current);

  const raw = extractEpubMeta(bytes);
  let coverName: string | null = null;
  if (raw.cover) {
    coverName = `cover.${raw.cover.ext}`;
    fs.writeFileSync(path.join(dir, `${coverName}.tmp`), raw.cover.bytes);
  }

  let meta: BookEdit = {};
  if (opts.metadataFromFile) {
    const existingAuthors = (
      db.prepare(`SELECT DISTINCT author FROM books WHERE author IS NOT NULL AND id != ?`).all(id) as Array<{
        author: string;
      }>
    ).map((r) => r.author);
    const n = normalizeMeta(raw, book.title, existingAuthors);
    meta = { ...n, language: raw.language, description: raw.description };
  }
  const next = { ...book, ...meta, ...(opts.edit ?? {}) };
  const now = new Date().toISOString();
  const wordCount = countEpubWords(bytes) ?? 0;
  let healthJson: string | null = null;
  try {
    healthJson = JSON.stringify({ ...checkEpubHealth(bytes), checkedAt: now });
  } catch {
    healthJson = null;
  }

  try {
    db.transaction(() => {
      db.prepare(
        `UPDATE books SET title = ?, author = ?, series = ?, series_index = ?, language = ?,
                description = ?, file_size = ?, sha256 = ?, partial_md5 = ?, cover_name = ?,
                word_count = ?, health_json = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        next.title,
        next.author,
        next.series,
        next.seriesIndex,
        next.language,
        next.description,
        bytes.length,
        sha256,
        key,
        coverName,
        wordCount,
        healthJson,
        now,
        id,
      );
      rekeyDocument(book.partialMd5, key);
    })();
  } catch (err) {
    if (oldBytes) fs.writeFileSync(current, oldBytes);
    if (coverName) fs.rmSync(path.join(dir, `${coverName}.tmp`), { force: true });
    throw err;
  }

  // Covers last: the old one goes only once the row no longer names it.
  if (book.coverName && book.coverName !== coverName) {
    fs.rmSync(path.join(dir, book.coverName), { force: true });
  }
  if (coverName) fs.renameSync(path.join(dir, `${coverName}.tmp`), path.join(dir, coverName));

  return {
    book: getBook(id)!,
    previous: { sha256: book.sha256, partialMd5: book.partialMd5 },
    textChanged,
  };
}

export type BookVersion = { sha256: string; size: number; archivedAt: string };

/** Earlier files of a book (newest first) — what restoreVersion can put back. */
export function listVersions(id: string): BookVersion[] {
  const dir = versionsDir(id);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^[0-9a-f]{64}\.epub$/.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { sha256: f.slice(0, 64), size: st.size, archivedAt: st.mtime.toISOString() };
    })
    .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
}

/** Put an archived file back — itself a replacement, so the current file is archived too. */
export function restoreVersion(id: string, sha256: string, opts: { metadataFromFile?: boolean } = {}): ReplaceResult {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new ReplaceError("no-version", "not a version id");
  const p = path.join(versionsDir(id), `${sha256}.epub`);
  if (!fs.existsSync(p)) throw new ReplaceError("no-version", "no such version of this book");
  return replaceBookFile(id, fs.readFileSync(p), opts);
}

export function deleteBook(id: string): boolean {
  const book = getBook(id);
  if (!book) return false;
  getDb().prepare(`DELETE FROM books WHERE id = ?`).run(id);
  // Progress rows in kosync_progress are deliberately kept — they key on the
  // content hash, not the book id, and deleting a book shouldn't forget where
  // the user was in it if the same bytes ever come back.
  fs.rmSync(path.join(booksDir(), id), { recursive: true, force: true });
  return true;
}
