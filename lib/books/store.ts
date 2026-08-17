import { createHash, randomUUID } from "crypto";
import fs from "fs";
import path from "path";
// Relative + explicit .ts (not the "@/" alias) so plain node can execute the
// check scripts against the REAL module — the hoops-lib convention, see
// CLAUDE.md "Relative imports inside lib/hoops/". Webpack accepts both.
import { getDb } from "../db.ts";
import { partialMd5 } from "./partialMd5.ts";
import { extractEpubMeta } from "./epubMeta.ts";
import { normalizeMeta } from "./normalize.ts";

// File storage: data/books/<id>/book.epub (+ cover.<ext>). One directory per
// book id — ids are stable under metadata edits, unlike titles.
//
// 🔴 The stored epub is IMMUTABLE (BOOKS_PLAN §4). The kosync document key is
// a partial MD5 of the bytes every device computes independently; a rewrite
// (metadata edit, "optimization", re-compression) silently detaches progress
// on every device at once. Metadata edits touch only the DB row. If a file
// must genuinely change, that is a NEW book id.

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

  try {
    db.prepare(
      `INSERT INTO books (id, title, author, series, series_index, language, description,
                          file_name, file_size, sha256, partial_md5, cover_name, added_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
