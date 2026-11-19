import type Database from "better-sqlite3";
import { LEGACY_COMIC_IDS } from "./comics-legacy-ids";

// One-time move of Comics read marks from the old Marvel Unlimited digital
// book ids to "mca-<Marvel Comics app id>" (Nov 2026; Marvel Unlimited closed
// Dec 28, 2026). Runs from getDb() on every start and does nothing once every
// known old id is gone, so it's safe to leave in place.
//
// Old ids and app ids are both bare numbers in overlapping ranges, which is
// why the new key carries a prefix: an UPDATE can never land on a row that is
// already a new key. An old row whose new key is already marked (it was
// re-ticked after the switch) just goes, keeping the newer mark. Rows for ids
// not in the map are left exactly as they are.
export function rekeyLegacyComicState(db: Database.Database): number {
  const legacy = db
    .prepare(`SELECT issue_id FROM comic_state WHERE issue_id NOT LIKE 'mca-%'`)
    .all() as { issue_id: string }[];
  const todo = legacy.filter((r) => Object.prototype.hasOwnProperty.call(LEGACY_COMIC_IDS, r.issue_id));
  if (todo.length === 0) return 0;

  const move = db.prepare(`UPDATE OR IGNORE comic_state SET issue_id = ? WHERE issue_id = ?`);
  const drop = db.prepare(`DELETE FROM comic_state WHERE issue_id = ?`);
  db.transaction(() => {
    for (const { issue_id } of todo) {
      move.run(`mca-${LEGACY_COMIC_IDS[issue_id]}`, issue_id);
      drop.run(issue_id); // only still there if the new key already existed
    }
  })();
  return todo.length;
}
