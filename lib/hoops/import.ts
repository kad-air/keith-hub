// Project the committed hoops-sim export into the SQLite read model.
//
// Wholesale rewrite, like the `sources` sync — not an incremental merge. The
// export is the source of truth for everything it covers, so a re-import
// deletes and re-inserts every read-model row inside one transaction.
//
// 🔴 The USER tables (hoops_scratch, hoops_runs) are NOT touched here. The
// data flows one way only: Mini → hub. Nothing in keith-hub ever writes back
// to hoops-sim.
//
// Trigger: lazily, once per process, on first hoops read (ensureHoopsImport).
// It's keyed on a content hash of the committed files, so a deploy carrying a
// fresh export imports it automatically, a restart on unchanged data is a
// single SELECT, and none of it goes anywhere near the background poller.

import type Database from "better-sqlite3";
import { getDb } from "@/lib/db";
import { bundleHash, loadBundle, readParamsBlobText } from "./data";
import { decodeParams } from "./params";
import type { HoopsBundle } from "./types";

export interface ImportSummary {
  imported: boolean;
  reason: "unchanged" | "first-import" | "content-changed";
  paramVersion: string;
  generatedAt: string;
  contentHash: string;
  counts: {
    teams: number;
    players: number;
    schedule: number;
    results: number;
    lines: number;
  };
}

function currentHash(db: Database.Database): { hash: string; count: number } | null {
  const row = db
    .prepare(`SELECT content_hash AS hash FROM hoops_params WHERE id = 1`)
    .get() as { hash: string } | undefined;
  if (!row) return null;
  const count = (
    db.prepare(`SELECT COUNT(*) AS n FROM hoops_teams`).get() as { n: number }
  ).n;
  return { hash: row.hash, count };
}

function writeBundle(db: Database.Database, bundle: HoopsBundle, hash: string): void {
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    // Read-model only. hoops_scratch / hoops_runs are deliberately absent.
    db.exec(`
      DELETE FROM hoops_teams;
      DELETE FROM hoops_players;
      DELETE FROM hoops_schedule;
      DELETE FROM hoops_results;
      DELETE FROM hoops_lines;
      DELETE FROM hoops_params;
    `);

    db.prepare(
      `INSERT INTO hoops_params (id, param_version, blob, generated_at, imported_at, content_hash)
       VALUES (1, ?, ?, ?, ?, ?)`,
    ).run(
      bundle.params.parameter_set.param_version,
      readParamsBlobText(),
      bundle.params.generated_at,
      now,
      hash,
    );

    const insTeam = db.prepare(
      `INSERT INTO hoops_teams
         (tri, conference, division, results_off, results_def, roster_off, roster_def, blend_off, blend_def)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [tri, t] of Object.entries(bundle.teams.teams)) {
      insTeam.run(
        tri,
        t.conference,
        t.division,
        t.results.off,
        t.results.def,
        t.roster.off,
        t.roster.def,
        t.blend.off,
        t.blend.def,
      );
    }

    const insPlayer = db.prepare(
      `INSERT INTO hoops_players
         (athlete_id, nba_player_id, tri, name, minutes, value_per36, game_rates, per36)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const p of bundle.players.players) {
      insPlayer.run(
        p.athlete_id,
        p.nba_player_id ?? null,
        p.team,
        p.name,
        p.minutes,
        p.value_per36 ?? null,
        p.game_rates ? JSON.stringify(p.game_rates) : null,
        p.per36 ? JSON.stringify(p.per36) : null,
      );
    }

    const insGame = db.prepare(
      `INSERT INTO hoops_schedule (game_id, date, home, away, neutral_site)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const g of bundle.schedule.games) {
      insGame.run(g.game_id, g.date, g.home, g.away, g.neutral_site ? 1 : 0);
    }

    const insResult = db.prepare(
      `INSERT INTO hoops_results (game_id, date, home, away, home_score, away_score, neutral_site)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const g of bundle.results.games) {
      insResult.run(
        g.game_id,
        g.date,
        g.home,
        g.away,
        g.home_score,
        g.away_score,
        g.neutral_site ? 1 : 0,
      );
    }

    const insLine = db.prepare(
      `INSERT INTO hoops_lines
         (game_id, date, home, away, home_spread, total, home_odds, away_odds, n_books_spread, n_books_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const l of bundle.lines.lines) {
      insLine.run(
        l.game_id,
        l.date,
        l.home,
        l.away,
        l.home_spread ?? null,
        l.total ?? null,
        l.home_odds ?? null,
        l.away_odds ?? null,
        l.n_books_spread ?? null,
        l.n_books_total ?? null,
      );
    }
  });

  tx();
}

/**
 * Import the committed export, unconditionally. Returns what it wrote.
 * `force` re-imports even when the content hash is unchanged.
 */
export function importHoopsData(force = false): ImportSummary {
  const db = getDb();
  const bundle = loadBundle();

  // 🔴 Stale-blob guard, on the write path. A blob the engine doesn't
  // recognise never reaches SQLite — decodeParams throws instead.
  decodeParams(bundle.params);

  const hash = bundleHash();
  const existing = currentHash(db);
  const counts = {
    teams: Object.keys(bundle.teams.teams).length,
    players: bundle.players.players.length,
    schedule: bundle.schedule.games.length,
    results: bundle.results.games.length,
    lines: bundle.lines.lines.length,
  };

  if (!force && existing && existing.hash === hash && existing.count > 0) {
    return {
      imported: false,
      reason: "unchanged",
      paramVersion: bundle.params.parameter_set.param_version,
      generatedAt: bundle.params.generated_at,
      contentHash: hash,
      counts,
    };
  }

  writeBundle(db, bundle, hash);

  // Post-write verification: what landed must be what the bundle said. A
  // silent row shortfall (a failed insert, a UNIQUE collision) would show up
  // three screens later as a missing team, which is exactly the kind of thing
  // that's very hard to see afterwards.
  const wrote = {
    teams: (db.prepare(`SELECT COUNT(*) AS n FROM hoops_teams`).get() as { n: number }).n,
    players: (db.prepare(`SELECT COUNT(*) AS n FROM hoops_players`).get() as { n: number }).n,
    schedule: (db.prepare(`SELECT COUNT(*) AS n FROM hoops_schedule`).get() as { n: number }).n,
    results: (db.prepare(`SELECT COUNT(*) AS n FROM hoops_results`).get() as { n: number }).n,
    lines: (db.prepare(`SELECT COUNT(*) AS n FROM hoops_lines`).get() as { n: number }).n,
  };
  for (const key of Object.keys(counts) as Array<keyof typeof counts>) {
    if (wrote[key] !== counts[key]) {
      throw new Error(
        `hoops import: wrote ${wrote[key]} ${key} rows but the bundle has ${counts[key]}`,
      );
    }
  }

  return {
    imported: true,
    reason: existing ? "content-changed" : "first-import",
    paramVersion: bundle.params.parameter_set.param_version,
    generatedAt: bundle.params.generated_at,
    contentHash: hash,
    counts,
  };
}

let ensured = false;

/**
 * Called by every hoops read. Cheap after the first call in a process — the
 * hash is computed once and memoized.
 */
export function ensureHoopsImport(): void {
  if (ensured) return;
  const summary = importHoopsData();
  if (summary.imported) {
    console.log(
      `[hoops] imported export ${summary.generatedAt} (${summary.reason}): ` +
        `${summary.counts.teams} teams, ${summary.counts.players} players, ` +
        `${summary.counts.schedule} scheduled, ${summary.counts.results} results, ` +
        `${summary.counts.lines} lines — PARAM_VERSION ${summary.paramVersion}`,
    );
  }
  ensured = true;
}
