import { getDb } from "../db.ts";

// The saved conversation behind "Ask about what you've read": one thread per
// book, in SQLite, so it is there on the phone and the desk alike.
//
// A question is stored the moment it is asked and its answer when the model
// finishes — even if the browser has gone (a phone put away mid-answer), so
// the answer is waiting on return. A question whose answer never came is
// removed, not left dangling: the thread always alternates question, answer.

export type AskTurn = {
  id: number;
  role: "user" | "assistant";
  content: string;
  /** The synced position (0..1) the turn was asked at. */
  percentage: number;
  /** Unix seconds. */
  createdAt: number;
};

/** How long an unanswered question counts as still being answered. */
export const PENDING_SECONDS = 300;

const now = () => Math.floor(Date.now() / 1000);

export function listTurns(bookId: string): AskTurn[] {
  return getDb()
    .prepare(
      `SELECT id, role, content, percentage, created_at AS createdAt
         FROM book_ask_turns WHERE book_id = ? ORDER BY id`,
    )
    .all(bookId) as AskTurn[];
}

/**
 * Store a new question. Returns its id, or null while an earlier question is
 * still being answered. An unanswered question older than PENDING_SECONDS is
 * one whose answer was lost (a restart mid-answer); it is dropped first.
 */
export function beginQuestion(bookId: string, question: string, percentage: number, at = now()): number | null {
  const db = getDb();
  return db.transaction(() => {
    const last = db
      .prepare(`SELECT id, role, created_at AS createdAt FROM book_ask_turns WHERE book_id = ? ORDER BY id DESC LIMIT 1`)
      .get(bookId) as { id: number; role: string; createdAt: number } | undefined;
    if (last?.role === "user") {
      if (at - last.createdAt < PENDING_SECONDS) return null;
      db.prepare(`DELETE FROM book_ask_turns WHERE id = ?`).run(last.id);
    }
    const r = db
      .prepare(`INSERT INTO book_ask_turns (book_id, role, content, percentage, created_at) VALUES (?, 'user', ?, ?, ?)`)
      .run(bookId, question, percentage, at);
    return Number(r.lastInsertRowid);
  })();
}

/** Store the answer to a question. A no-op if the question is gone (the thread was cleared meanwhile). */
export function completeAnswer(bookId: string, questionId: number, answer: string, percentage: number, at = now()): void {
  const db = getDb();
  db.transaction(() => {
    const q = db.prepare(`SELECT 1 FROM book_ask_turns WHERE id = ? AND book_id = ? AND role = 'user'`).get(questionId, bookId);
    if (!q) return;
    db.prepare(`INSERT INTO book_ask_turns (book_id, role, content, percentage, created_at) VALUES (?, 'assistant', ?, ?, ?)`)
      .run(bookId, answer, percentage, at);
  })();
}

/** Remove a question that got no answer. */
export function dropQuestion(bookId: string, questionId: number): void {
  getDb().prepare(`DELETE FROM book_ask_turns WHERE id = ? AND book_id = ? AND role = 'user'`).run(questionId, bookId);
}

export function clearTurns(bookId: string): number {
  return getDb().prepare(`DELETE FROM book_ask_turns WHERE book_id = ?`).run(bookId).changes;
}

/** Whether the thread's last turn is a question still waiting for its answer. */
export function isPending(turns: AskTurn[], at = now()): boolean {
  const last = turns[turns.length - 1];
  return last != null && last.role === "user" && at - last.createdAt < PENDING_SECONDS;
}
