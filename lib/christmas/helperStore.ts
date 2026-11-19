import { getDb } from "@/lib/db";

// The helper's conversation: one thread for the whole list, in SQLite, so
// Keith and Kim see the same one on every device. Adapted from the books ask
// thread (lib/books/askStore.ts): a question is stored when asked and its
// answer when the model finishes — even if the browser has gone — and a
// question whose answer never came is removed, so the thread alternates.

export type UndoStep =
  | { t: "del"; path: string }
  | { t: "set"; path: string; data: Record<string, unknown> };

export type Asker = "Keith" | "Kim";

export type HelperTurn = {
  id: number;
  role: "user" | "assistant";
  /** Who asked: "Keith" or "Kim". Questions only; null on answers. */
  author: Asker | null;
  content: string;
  /** What the answer changed, one line each. Assistant turns only. */
  changes: string[];
  /** Whether those changes can still be undone (they exist and haven't been). */
  undoable: boolean;
  undone: boolean;
  /** Unix seconds. */
  createdAt: number;
};

type Row = {
  id: number;
  role: "user" | "assistant";
  author: string | null;
  content: string;
  changes_json: string | null;
  undo_json: string | null;
  undone_at: number | null;
  created_at: number;
};

/** How long an unanswered question counts as still being answered. */
export const PENDING_SECONDS = 300;

const now = () => Math.floor(Date.now() / 1000);

function toTurn(r: Row): HelperTurn {
  const changes = r.changes_json ? (JSON.parse(r.changes_json) as string[]) : [];
  return {
    id: r.id,
    role: r.role,
    author: r.author === "Keith" || r.author === "Kim" ? r.author : null,
    content: r.content,
    changes,
    undoable: Boolean(r.undo_json) && r.undone_at == null,
    undone: r.undone_at != null,
    createdAt: r.created_at,
  };
}

export function listTurns(): HelperTurn[] {
  return (getDb().prepare("SELECT * FROM xmas_helper_turns ORDER BY id").all() as Row[]).map(toTurn);
}

/** Store a new question; null while an earlier one is still being answered. */
export function beginQuestion(question: string, author: Asker, at = now()): number | null {
  const db = getDb();
  return db.transaction(() => {
    const last = db.prepare("SELECT id, role, created_at FROM xmas_helper_turns ORDER BY id DESC LIMIT 1").get() as
      | { id: number; role: string; created_at: number }
      | undefined;
    if (last?.role === "user") {
      if (at - last.created_at < PENDING_SECONDS) return null;
      db.prepare("DELETE FROM xmas_helper_turns WHERE id = ?").run(last.id);
    }
    const r = db
      .prepare("INSERT INTO xmas_helper_turns (role, author, content, created_at) VALUES ('user', ?, ?, ?)")
      .run(author, question, at);
    return Number(r.lastInsertRowid);
  })();
}

/** Store the answer. A no-op if the question is gone (the thread was cleared meanwhile). */
export function completeAnswer(questionId: number, answer: string, changes: string[], undo: UndoStep[], at = now()): void {
  const db = getDb();
  db.transaction(() => {
    if (!db.prepare("SELECT 1 FROM xmas_helper_turns WHERE id = ? AND role = 'user'").get(questionId)) return;
    db.prepare(
      "INSERT INTO xmas_helper_turns (role, content, changes_json, undo_json, created_at) VALUES ('assistant', ?, ?, ?, ?)",
    ).run(answer, changes.length ? JSON.stringify(changes) : null, undo.length ? JSON.stringify(undo) : null, at);
  })();
}

export function dropQuestion(questionId: number): void {
  getDb().prepare("DELETE FROM xmas_helper_turns WHERE id = ? AND role = 'user'").run(questionId);
}

export function clearTurns(): number {
  return getDb().prepare("DELETE FROM xmas_helper_turns").run().changes;
}

export function isPending(turns: HelperTurn[], at = now()): boolean {
  const last = turns[turns.length - 1];
  return last != null && last.role === "user" && at - last.createdAt < PENDING_SECONDS;
}

/** The undo steps of an answer that can still be undone, or null. */
export function undoStepsFor(turnId: number): UndoStep[] | null {
  const r = getDb()
    .prepare("SELECT undo_json, undone_at FROM xmas_helper_turns WHERE id = ? AND role = 'assistant'")
    .get(turnId) as { undo_json: string | null; undone_at: number | null } | undefined;
  if (!r || !r.undo_json || r.undone_at != null) return null;
  return JSON.parse(r.undo_json) as UndoStep[];
}

export function markUndone(turnId: number, at = now()): void {
  getDb().prepare("UPDATE xmas_helper_turns SET undone_at = ? WHERE id = ?").run(at, turnId);
}
