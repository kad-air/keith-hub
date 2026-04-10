#!/usr/bin/env node
/**
 * The Feed — runtime inspection tool.
 *
 * Run from the keith-hub repo root:
 *   node scripts/inspect.mjs <command> [args]
 *
 * Designed so Claude (or you) can verify the current state of the running
 * Feed without poking sqlite/curl/pm2 by hand. Read-only against the DB,
 * read-only against the live HTTP endpoint (except `refresh` which POSTs).
 *
 * Add new commands by registering them in the COMMANDS map at the bottom.
 */

import Database from "better-sqlite3";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const DB_PATH = join(ROOT, "data/the-feed.db");
const FEED_BASE = "https://keiths-mac-mini-1110.tail846fa.ts.net:10000";

// ── ANSI helpers ────────────────────────────────────────────────────────────

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
  magenta: (s) => `\x1b[35m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

function header(text) {
  console.log("\n" + c.bold(c.cyan(text)));
  console.log(c.dim("─".repeat(Math.min(text.length, 60))));
}

function table(rows, columns) {
  if (rows.length === 0) {
    console.log(c.dim("  (no rows)"));
    return;
  }
  const widths = columns.map((col) =>
    Math.max(col.label.length, ...rows.map((r) => String(col.get(r) ?? "").length))
  );
  const line = (cells) =>
    cells.map((cell, i) => String(cell).padEnd(widths[i])).join("  ");
  console.log(c.dim(line(columns.map((c) => c.label))));
  console.log(c.dim(line(widths.map((w) => "─".repeat(w)))));
  for (const row of rows) {
    console.log(line(columns.map((col) => col.get(row) ?? "")));
  }
}

function relativeTime(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "future";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function shortId(id) {
  return id ? id.slice(0, 8) : "—";
}

function truncate(s, n) {
  if (!s) return "";
  s = String(s).replace(/\s+/g, " ");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ── DB ──────────────────────────────────────────────────────────────────────

let _db = null;
function db() {
  if (_db) return _db;
  if (!existsSync(DB_PATH)) {
    console.error(c.red(`No database at ${DB_PATH}`));
    console.error(c.dim("Run from the keith-hub repo root."));
    process.exit(1);
  }
  _db = new Database(DB_PATH, { readonly: true });
  // Honor WAL mode the live writer is using.
  _db.pragma("journal_mode = WAL");
  return _db;
}

function parseJson(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { _parseError: true, _raw: raw };
  }
}

// ── Commands ────────────────────────────────────────────────────────────────

function counts() {
  const conn = db();

  header("Items by category × state");
  const rows = conn
    .prepare(
      `SELECT
         s.category as cat,
         COUNT(*) as total,
         SUM(CASE WHEN ist.read_at IS NULL THEN 1 ELSE 0 END) as unread,
         SUM(CASE WHEN ist.read_at IS NOT NULL THEN 1 ELSE 0 END) as read,
         SUM(CASE WHEN ist.saved_at IS NOT NULL THEN 1 ELSE 0 END) as saved,
         SUM(CASE WHEN ist.consumed_at IS NOT NULL THEN 1 ELSE 0 END) as opened
       FROM items i
       JOIN sources s ON s.id = i.source_id
       LEFT JOIN item_state ist ON ist.item_id = i.id
       GROUP BY s.category
       ORDER BY total DESC`
    )
    .all();
  table(rows, [
    { label: "category", get: (r) => r.cat },
    { label: "total", get: (r) => r.total },
    { label: "unread", get: (r) => r.unread },
    { label: "read", get: (r) => r.read },
    { label: "saved", get: (r) => r.saved },
    { label: "opened", get: (r) => r.opened },
  ]);

  header("Bluesky rich content (subset of bluesky items)");
  const richRow = conn
    .prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN i.metadata LIKE '%display_name%' THEN 1 ELSE 0 END) as new_format,
         SUM(CASE WHEN i.metadata LIKE '%"images"%' THEN 1 ELSE 0 END) as images,
         SUM(CASE WHEN i.metadata LIKE '%"external"%' THEN 1 ELSE 0 END) as external,
         SUM(CASE WHEN i.metadata LIKE '%"quoted"%' THEN 1 ELSE 0 END) as quoted,
         SUM(CASE WHEN i.metadata LIKE '%"reply_to"%' THEN 1 ELSE 0 END) as reply,
         SUM(CASE WHEN i.metadata LIKE '%"reposted_by"%' THEN 1 ELSE 0 END) as repost
       FROM items i
       JOIN sources s ON s.id = i.source_id
       WHERE s.category = 'bluesky'`
    )
    .get();
  table([richRow], [
    { label: "total", get: (r) => r.total },
    { label: "new format", get: (r) => r.new_format },
    { label: "images", get: (r) => r.images },
    { label: "external", get: (r) => r.external },
    { label: "quoted", get: (r) => r.quoted },
    { label: "reply", get: (r) => r.reply },
    { label: "repost", get: (r) => r.repost },
  ]);

  header("Item state row counts");
  const stateRow = conn
    .prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN read_at IS NOT NULL THEN 1 ELSE 0 END) as read,
         SUM(CASE WHEN saved_at IS NOT NULL THEN 1 ELSE 0 END) as saved,
         SUM(CASE WHEN consumed_at IS NOT NULL THEN 1 ELSE 0 END) as consumed
       FROM item_state`
    )
    .get();
  table([stateRow], [
    { label: "rows", get: (r) => r.total },
    { label: "read", get: (r) => r.read },
    { label: "saved", get: (r) => r.saved },
    { label: "consumed", get: (r) => r.consumed },
  ]);
}

function items(args) {
  const category = args[0];
  if (!category) {
    console.error(c.red("Usage: items <category> [--unread|--read|--saved|--all] [--limit N]"));
    console.error(c.dim("Categories: all reading music film podcasts bluesky"));
    process.exit(1);
  }
  const filter =
    args.includes("--read") ? "read"
    : args.includes("--saved") ? "saved"
    : args.includes("--all") ? "all"
    : "unread";
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1] ?? "20", 10) : 20;

  const where = [];
  if (category !== "all") where.push(`s.category = '${category}'`);
  if (filter === "unread") where.push(`ist.read_at IS NULL`);
  if (filter === "read") where.push(`ist.read_at IS NOT NULL`);
  if (filter === "saved") where.push(`ist.saved_at IS NOT NULL`);

  const sql = `
    SELECT
      i.id, i.title, i.body_excerpt, i.url, i.published_at,
      s.name as source_name, s.category as cat,
      ist.read_at, ist.saved_at, ist.consumed_at
    FROM items i
    JOIN sources s ON s.id = i.source_id
    LEFT JOIN item_state ist ON ist.item_id = i.id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY i.published_at DESC
    LIMIT ?
  `;
  const rows = db().prepare(sql).all(limit);

  header(`${rows.length} items — category=${category} filter=${filter}`);
  table(rows, [
    { label: "id", get: (r) => shortId(r.id) },
    { label: "cat", get: (r) => r.cat },
    { label: "src", get: (r) => truncate(r.source_name, 14) },
    { label: "age", get: (r) => relativeTime(r.published_at) },
    { label: "state", get: (r) => {
      const tags = [];
      if (r.consumed_at) tags.push(c.green("opened"));
      else if (r.read_at) tags.push(c.dim("read"));
      else tags.push(c.cyan("unread"));
      if (r.saved_at) tags.push(c.yellow("saved"));
      return tags.join(" ");
    }},
    { label: "title/text", get: (r) => truncate(r.title || r.body_excerpt, 60) },
  ]);
}

function item(args) {
  const idPrefix = args[0];
  if (!idPrefix) {
    console.error(c.red("Usage: item <id-prefix>"));
    process.exit(1);
  }
  const row = db()
    .prepare(
      `SELECT i.*, s.name as source_name, s.category as cat,
              ist.read_at, ist.saved_at, ist.consumed_at, ist.notes
       FROM items i
       JOIN sources s ON s.id = i.source_id
       LEFT JOIN item_state ist ON ist.item_id = i.id
       WHERE i.id LIKE ? || '%'
       LIMIT 1`
    )
    .get(idPrefix);
  if (!row) {
    console.error(c.red(`No item matching id prefix '${idPrefix}'`));
    process.exit(1);
  }

  header(`Item ${shortId(row.id)}`);
  console.log(`  ${c.dim("id")}          ${row.id}`);
  console.log(`  ${c.dim("source")}      ${row.source_name} (${row.cat})`);
  console.log(`  ${c.dim("title")}       ${row.title || c.dim("(none)")}`);
  console.log(`  ${c.dim("body")}        ${truncate(row.body_excerpt, 200)}`);
  console.log(`  ${c.dim("url")}         ${row.url}`);
  console.log(`  ${c.dim("image_url")}   ${row.image_url || c.dim("(none)")}`);
  console.log(`  ${c.dim("published")}   ${row.published_at}  ${c.dim("(" + relativeTime(row.published_at) + ")")}`);
  console.log(`  ${c.dim("fetched")}     ${row.fetched_at}    ${c.dim("(" + relativeTime(row.fetched_at) + ")")}`);
  console.log(`  ${c.dim("read_at")}     ${row.read_at || c.dim("—")}`);
  console.log(`  ${c.dim("saved_at")}    ${row.saved_at || c.dim("—")}`);
  console.log(`  ${c.dim("consumed_at")} ${row.consumed_at || c.dim("—")}`);

  const meta = parseJson(row.metadata);
  if (meta) {
    header("Parsed metadata");
    console.log(JSON.stringify(meta, null, 2));
  }
}

function sources() {
  const rows = db()
    .prepare(
      `SELECT s.id, s.name, s.type, s.category, s.last_fetched_at,
              (SELECT COUNT(*) FROM items i WHERE i.source_id = s.id) as item_count,
              (SELECT COUNT(*) FROM items i
                 LEFT JOIN item_state ist ON ist.item_id = i.id
                 WHERE i.source_id = s.id AND ist.read_at IS NULL) as unread_count
       FROM sources s
       ORDER BY s.category, s.name`
    )
    .all();

  header(`${rows.length} sources`);
  table(rows, [
    { label: "id", get: (r) => truncate(r.id, 18) },
    { label: "name", get: (r) => truncate(r.name, 24) },
    { label: "type", get: (r) => r.type },
    { label: "cat", get: (r) => r.category },
    { label: "items", get: (r) => r.item_count },
    { label: "unread", get: (r) => r.unread_count },
    { label: "last fetch", get: (r) => relativeTime(r.last_fetched_at) },
  ]);
}

function bskyRich(args) {
  const kind = args[0]; // optional: images|external|quoted|reply|repost

  const filterMap = {
    images: `metadata LIKE '%"images"%'`,
    external: `metadata LIKE '%"external"%'`,
    quoted: `metadata LIKE '%"quoted"%'`,
    reply: `metadata LIKE '%"reply_to"%'`,
    repost: `metadata LIKE '%"reposted_by"%'`,
  };

  if (kind && !filterMap[kind]) {
    console.error(c.red(`Unknown kind '${kind}'`));
    console.error(c.dim("Try: images external quoted reply repost"));
    process.exit(1);
  }

  if (kind) {
    const rows = db()
      .prepare(
        `SELECT i.id, i.body_excerpt, i.metadata, i.published_at,
                ist.read_at
         FROM items i
         JOIN sources s ON s.id = i.source_id
         LEFT JOIN item_state ist ON ist.item_id = i.id
         WHERE s.category = 'bluesky' AND ${filterMap[kind]}
         ORDER BY i.published_at DESC
         LIMIT 5`
      )
      .all();
    header(`Bluesky items with '${kind}' (${rows.length})`);
    for (const row of rows) {
      const meta = parseJson(row.metadata);
      console.log(`\n${c.bold(shortId(row.id))} ${c.dim(relativeTime(row.published_at))} ${row.read_at ? c.dim("[read]") : c.cyan("[unread]")}`);
      console.log(`  ${truncate(row.body_excerpt, 80)}`);
      if (meta && meta[kind === "reply" ? "reply_to" : kind === "repost" ? "reposted_by" : kind]) {
        const value = meta[kind === "reply" ? "reply_to" : kind === "repost" ? "reposted_by" : kind];
        console.log(c.dim("  " + JSON.stringify(value).slice(0, 200)));
      }
    }
    return;
  }

  // No kind: summary of all rich types
  header("Bluesky rich content summary");
  for (const [k, where] of Object.entries(filterMap)) {
    const row = db()
      .prepare(
        `SELECT COUNT(*) as n FROM items i
         JOIN sources s ON s.id = i.source_id
         WHERE s.category = 'bluesky' AND ${where}`
      )
      .get();
    console.log(`  ${k.padEnd(10)} ${row.n}`);
  }
  console.log(c.dim("\nRun `bsky-rich <kind>` for details on a specific kind."));
}

async function html() {
  const path = process.argv[3] || "/";
  const url = `${FEED_BASE}${path}?cb=${Date.now()}`;
  header(`GET ${url}`);
  const res = await fetch(url, { method: "GET" });
  const text = await res.text();
  console.log(`  ${c.dim("status")}     ${res.status}`);
  console.log(`  ${c.dim("size")}       ${(text.length / 1024).toFixed(1)}KB`);

  // Structural counts — what's in the rendered HTML. Each pattern matches a
  // marker that ONLY shows up in the corresponding component's rendered
  // output, so the count corresponds to actual rendered instances.
  const counts = {
    "feed cards (article)":    (text.match(/data-feed-index/g) || []).length,
    "bsky author avatars":     (text.match(/h-4 w-4 flex-shrink-0 rounded-full/g) || []).length,
    "quoted post avatars":     (text.match(/h-3\.5 w-3\.5 flex-shrink-0 rounded-full/g) || []).length,
    "embed images":            (text.match(/feed_fullsize|feed_thumbnail/g) || []).length,
    // ExternalCard: <a class="flex overflow-hidden rounded-sm border ...">
    "external link cards":     (text.match(/<a [^>]*class="flex overflow-hidden rounded-sm border/g) || []).length,
    // QuotedPost: <a class="block rounded-sm border border-rule bg-ink/60 px-3.5">
    "quoted post cards":       (text.match(/<a [^>]*class="block rounded-sm border border-rule/g) || []).length,
    // ReplyContext: <div class="mb-2 flex gap-2 border-l-2 border-rule pl-3 ...">
    "reply contexts":          (text.match(/border-l-2 border-rule pl-3/g) || []).length,
    "reposted-by banners":     (text.match(/Reposted by/g) || []).length,
    "manifest links":          (text.match(/<link rel="manifest"/g) || []).length,
  };
  header("Structural counts");
  for (const [k, v] of Object.entries(counts)) {
    console.log(`  ${k.padEnd(24)} ${v}`);
  }

  // Confirm there's a single clean manifest link with no use-credentials
  const manifestMatches = text.match(/<link[^>]*manifest[^>]*>/g) || [];
  if (manifestMatches.length > 0) {
    header("Manifest link tags");
    for (const m of manifestMatches) console.log(`  ${m}`);
  }
}

function logs(args) {
  const n = parseInt(args[0] ?? "30", 10);
  const cmd = spawnSync("pm2", ["logs", "the-feed", "--lines", String(n), "--nostream"], {
    encoding: "utf8",
  });
  if (cmd.status !== 0) {
    console.error(c.red("pm2 logs failed:"), cmd.stderr);
    process.exit(1);
  }
  console.log(cmd.stdout);
}

async function refresh() {
  header(`POST ${FEED_BASE}/api/refresh`);
  const res = await fetch(`${FEED_BASE}/api/refresh`, { method: "POST" });
  const json = await res.json().catch(() => ({}));
  console.log(`  ${c.dim("status")}     ${res.status}`);
  console.log(`  ${c.dim("response")}   ${JSON.stringify(json)}`);
}

function help() {
  console.log(`
${c.bold("The Feed — runtime inspection tool")}

${c.bold("Usage:")} node scripts/inspect.mjs <command> [args]

${c.bold("Commands:")}
  ${c.cyan("counts")}                      Items by category × state, plus Bluesky rich-content rollup
  ${c.cyan("items <category> [filter]")}   List items
                                ${c.dim("category: all reading music film podcasts bluesky")}
                                ${c.dim("filter:   --unread (default) --read --saved --all")}
                                ${c.dim("--limit N (default 20)")}
  ${c.cyan("item <id-prefix>")}            Full detail of one item, parsed metadata
  ${c.cyan("sources")}                     Configured sources, item counts, last fetch
  ${c.cyan("bsky-rich [kind]")}            Find Bluesky items with rich content
                                ${c.dim("kinds: images external quoted reply repost")}
  ${c.cyan("html [path]")}                 Fetch live page, count rendered structures
  ${c.cyan("logs [n]")}                    Last N pm2 log lines (default 30)
  ${c.cyan("refresh")}                     POST /api/refresh and report
  ${c.cyan("help")}                        This help
`);
}

const COMMANDS = {
  counts,
  items,
  item,
  sources,
  "bsky-rich": bskyRich,
  html,
  logs,
  refresh,
  help,
};

const [cmd, ...args] = process.argv.slice(2);
const fn = COMMANDS[cmd ?? "help"];
if (!fn) {
  console.error(c.red(`Unknown command: ${cmd}`));
  help();
  process.exit(1);
}
await fn(args);
