# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**The Feed** — a self-hosted personal content hub. Next.js 14 App Router + SQLite + Tailwind. Runs on a Mac Mini, accessible via Tailscale only. Single user, no auth.

See `PRODUCT_PLAN.md` for product vision and design principles. The most load-bearing ones: **finite, not infinite** (no infinite scroll — you reach the end and stop), **triage, not consumption** (scan/save/dismiss here, consume in native apps), and **config over UI** (sources are managed by editing `config/feeds.yml` — there's no admin screen).

## Commands

```bash
npm run dev        # Start dev server (http://localhost:3000)
npm run build      # Production build (run before committing to verify types)
npm run start      # Start production server
npm run lint       # next lint — not enforced in CI, but available
```

No test suite. `npm run build` is the type-check gate — always run it before pushing.

## Architecture

### Data flow
1. On first page load, `app/page.tsx` calls `ensureInitialized()` (lib/init.ts) which starts the background polling loop
2. The poller calls `fetchAllSources()` (lib/fetcher.ts) on an interval, which re-reads `config/feeds.yml` each cycle, syncs the `sources` table, fetches new content, and **auto-prunes any sources/items removed from config**
3. The page queries SQLite directly (not via API) for the initial SSR render, then the client uses `/api/items` for filtering/refresh

### Database schema (three tables)
- `sources` — mirrors `config/feeds.yml`; rewritten every poll cycle
- `items` — fetched content, unique on `(source_id, external_id)` so re-fetches are idempotent
- `item_state` — per-item user state: `read_at`, `saved_at`, `consumed_at`, `notes`. Rows are created lazily on first interaction, so **`LEFT JOIN item_state` is the correct join** (an inner join would hide untouched items)

### Feed filtering invariants
- The main feed (and `/api/items`) shows only unread items: `WHERE ist.read_at IS NULL`. Marking read is how items leave the feed.
- The "All" view uses the **hyperbolic ranked sort** in `RANKED_ORDER` (lib/db.ts): `score = weight / (age_hours + C)` where `C = 2` flattens the curve in the first couple of hours. Current weights: podcasts 8, music/film 6, reading 3, bluesky 1. Tune in the `WEIGHTS` const in lib/db.ts, not in callers.
- **Category-filtered views use pure recency** (`ORDER BY published_at DESC`), not the ranked sort — see app/api/items/route.ts:46. This is intentional: ranking only makes sense when categories are competing.
- The `/saved` view (app/saved/page.tsx) reads items where `saved_at IS NOT NULL`, ordered by `saved_at DESC`.
- **Saving auto-marks-read** (app/api/items/[id]/save/route.ts): the save endpoint sets both `saved_at` and `read_at` when toggling on, so saved items leave the main feed and live in `/saved`. Each item gets a verdict — this is the triage principle. Unsaving does NOT touch `read_at` (the item stays read).
- Per-category counts come from `getCategoryCounts(db)` in `lib/queries.ts` — a single grouped query returned alongside `/api/items` results so the tabs can show `READING · 12` etc.

### Key files
- `lib/db.ts` — SQLite singleton via `better-sqlite3` (synchronous). DB lives at `data/the-feed.db`. Also exports `RANKED_ORDER` (the SQL fragment for the "All" feed's weighted hyperbolic decay sort)
- `lib/queries.ts` — shared read queries (currently `getCategoryCounts`)
- `lib/config.ts` — YAML config parser. `invalidateConfig()` is called each poll cycle so `feeds.yml` changes take effect without restart
- `lib/fetcher.ts` — RSS/podcast fetcher. Also calls `fetchBlueskySource` for Bluesky sources
- `lib/bluesky.ts` — AT Protocol fetcher using `@atproto/api`. Authenticates once, re-auths on session expiry
- `lib/groupByDate.ts` — buckets items into Today / Yesterday / This week / Earlier (preserves input order within buckets, so the caller's sort wins)
- `lib/useKeyboard.ts` — keyboard shortcut hook with single-key + chord (`g h`) support. Ignores typing in inputs and any modifier-key combo (preserving cmd/ctrl shortcuts)
- `components/FeedCard.tsx` — renders all item types in three magazine variants (article, bluesky post, podcast). `forwardRef`s the article so the keyboard nav can scroll-into-view. Podcasts tap to Apple Podcasts via `apple_id`
- `components/FeedClient.tsx` / `SavedClient.tsx` — page-level state, keyboard shortcuts, refresh, dismiss/save/undo flow
- `components/Toast.tsx` — undo toast with countdown progress bar
- `components/KeyboardHelp.tsx` — `?` overlay listing shortcuts

### Visual identity
- Fonts loaded via `next/font/google` in `app/layout.tsx`: **Newsreader** (display + body, variable serif) and **JetBrains Mono** (kickers, badges, timestamps). Both exposed as CSS vars `--font-display` / `--font-mono` and aliased in `tailwind.config.ts` as `font-display` / `font-mono`
- Theme tokens live in `tailwind.config.ts` (`ink`, `cream`, `rule`, `accent`, per-category `cat.*`). Don't hardcode hexes in components — extend the theme

### API routes
- `GET  /api/items?category=&limit=&offset=` — lists unread items, ranked for "all", recent for categories. Response includes `counts: CategoryCounts` for the tab labels
- `POST /api/items/[id]/read` — marks read (upserts `item_state.read_at`)
- `POST /api/items/[id]/unread` — clears `read_at` (used by undo)
- `POST /api/items/[id]/save` — toggles saved. **When toggling on, also sets `read_at`** so the item leaves the main feed
- `POST /api/items/read-bulk` — body `{ ids: string[], unread?: boolean }`. Bulk mark-read in a single transaction. Used by "Dismiss all" and bulk undo
- `POST /api/refresh` — forces an immediate `fetchAllSources()` run

### Keyboard shortcuts
Defined in `components/FeedClient.tsx` (and a subset in `SavedClient.tsx`). Source of truth for the user-facing list is `components/KeyboardHelp.tsx`. Keys: `j`/`k` nav, `o`/`enter` open, `s` save, `x`/`e` dismiss, `r` refresh, `g h` / `g s` go home/saved, `?` toggle help.

### Source types in config
- `type: rss` / `type: podcast` — both use the RSS fetcher; podcasts additionally parse `itunes:*` fields and store `apple_id`, `duration`, `artwork_url` in the `metadata` JSON column
- `type: bluesky` with `mode: feed` + `feed_uri` — fetches a specific Bluesky algorithmic feed (currently "Popular With Friends")
- `mode: account` + `handle` also supported for individual Bluesky accounts

### Config is the source of truth
`config/feeds.yml` is the admin panel (not in git — only `config/feeds.example.yml` is committed). Adding/removing a source from the YAML and hitting browser refresh is all that's needed — the next poll cycle syncs the DB automatically.

### Item metadata
The `metadata` column is a JSON blob. Schema varies by type:
- Podcast: `{ show_name, duration, audio_url, artwork_url, apple_id }`
- Bluesky: `{ handle, avatar_url, like_count, reply_count, repost_count }`

### Deployment
- PM2 on Mac Mini (`ecosystem.config.js`)
- `scripts/deploy.sh` is a cron-based auto-deploy script (runs every 2 min, pulls and restarts only if there are new commits)
- Files that live only on the Mini and are never committed: `config/feeds.yml`, `.env`, `data/the-feed.db`

### Environment variables
- `BLUESKY_IDENTIFIER` — Bluesky handle (e.g. `keithadair.com`)
- `BLUESKY_APP_PASSWORD` — Bluesky app password (not account password)

### Git auth
The repo pushes via HTTPS with a PAT stored in `~/.git-credentials`. SSH doesn't work in this session because the SSH agent routes through 1Password which isn't accessible from Claude Code's shell.
