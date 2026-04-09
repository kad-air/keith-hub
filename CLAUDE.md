# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**The Feed** — a self-hosted personal content hub. Next.js 14 App Router + SQLite + Tailwind. Runs on a Mac Mini, accessible via Tailscale only. Single user, no auth. Triage layer over RSS/Bluesky/podcasts — scan, save, dismiss, then hand off to a native app for actual consumption. See `PRODUCT_PLAN.md` for the full vision and design principles ("finite, not infinite", "config over UI", etc.).

## Commands

```bash
npm run dev        # Start dev server (http://localhost:3000)
npm run build      # Production build (run before committing to verify types)
npm run start      # Start production server
```

No test suite. No linter wired up (`next lint` exists in package.json but isn't enforced). **`npm run build` is the type-check gate — always run it before pushing.**

## Architecture

### Data flow
1. On first page load, `app/page.tsx` calls `ensureInitialized()` (`lib/init.ts`) which lazily opens the SQLite singleton and starts the background polling loop.
2. The poller calls `fetchAllSources()` (`lib/fetcher.ts`) immediately and then on `app.poll_interval_minutes`. Each cycle re-reads `config/feeds.yml` (via `invalidateConfig()`), syncs the `sources` table, fetches new content, and **auto-prunes any sources/items removed from config**.
3. The home page queries SQLite directly (not via API) for the SSR render, then the client uses `/api/items` for category filtering and `/api/refresh` for the manual refresh button.

### Routes
- `/` — main feed (`app/page.tsx` → `components/FeedClient.tsx`). Hides items where `item_state.read_at IS NOT NULL`. "All" tab uses ranked sort; category tabs use pure recency.
- `/saved` — saved-for-later view (`app/saved/page.tsx` → `components/SavedClient.tsx`). Shows items where `item_state.saved_at IS NOT NULL`, ordered by save time.
- `GET /api/items?category=&limit=&offset=` — paginated feed query. Used by category tab switches and refresh.
- `POST /api/refresh` — force a `fetchAllSources()` cycle, returns `{ fetched }`.
- `POST /api/items/[id]/read` — marks an item read (used by Open and Dismiss). Read items disappear from the main feed.
- `POST /api/items/[id]/save` — toggles `saved_at`. Saving and dismissing are independent — a saved item can also be read/dismissed.

### Key files
- `lib/db.ts` — SQLite singleton via `better-sqlite3` (synchronous). DB lives at `data/the-feed.db`. Owns the schema (`sources`, `items`, `item_state`) and exports `RANKED_ORDER`, the SQL fragment used by ranked queries.
- `lib/config.ts` — YAML config parser. `invalidateConfig()` is called each poll cycle so `feeds.yml` edits take effect without restart. Falls back to `feeds.example.yml` if `feeds.yml` is missing.
- `lib/fetcher.ts` — RSS/podcast fetcher + the polling loop. Also dispatches Bluesky sources to `fetchBlueskySource`. Uses `INSERT OR IGNORE` against the `(source_id, external_id)` unique index for idempotent inserts.
- `lib/bluesky.ts` — AT Protocol fetcher using `@atproto/api`. Authenticates once into a module-level `agent`, nulls it on error so the next call re-auths.
- `lib/init.ts` — `ensureInitialized()` guard so polling starts exactly once per process.
- `lib/types.ts` — shared `Item` and `ItemsResponse` types.
- `components/FeedCard.tsx` — renders all item types (RSS, podcast, Bluesky). Bluesky posts have no title (body text is primary), podcasts get a 64px artwork thumbnail and tap to the Apple Podcasts show page via `apple_id`. Uses inline styles, not Tailwind classes.
- `components/FeedClient.tsx` — main feed client. Owns category tabs, refresh button, optimistic dismiss.
- `components/SavedClient.tsx` — saved view client. Reuses `FeedCard`; unsaving removes the item from the local list.

### Schema (SQLite)
- `sources` — id (text PK), name, type, category, last_fetched_at, last_item_id. Mirrors `config/feeds.yml`.
- `items` — id (uuid), source_id (FK), external_id, title, body_excerpt, author, url, image_url, published_at, fetched_at, metadata (JSON). `UNIQUE(source_id, external_id)` is the dedup key.
- `item_state` — item_id (PK/FK), read_at, saved_at, consumed_at, notes. Separate table so items can be pruned/re-fetched without losing user state… though in practice the cascade in `fetchAllSources` deletes state for removed sources.

### Source types in config
- `type: rss` / `type: podcast` — both use the RSS fetcher; podcasts additionally parse `itunes:*` fields and store `{show_name, duration, audio_url, artwork_url, apple_id}` in the `metadata` JSON column. Feed-level artwork is read via rss-parser's native `feed.itunes.image`.
- `type: bluesky` with `mode: feed` + `feed_uri` — fetches a Bluesky algorithmic feed (default config: "Popular With Friends").
- `type: bluesky` with `mode: account` + `handle` — individual Bluesky account (uses `getAuthorFeed`, filters out replies).
- `type: bluesky` with `mode: timeline` — the authenticated user's home timeline.

### Ranked sort (All feed)
`lib/db.ts` exports `RANKED_ORDER`, a SQL fragment used by `app/page.tsx` and `/api/items` (only when no category filter is active). It's a hyperbolic decay score, same family as Hacker News:

```
score = WEIGHT[category] / (age_hours + C)
```

Weights live in `lib/db.ts` (`podcasts: 8, music: 6, film: 6, reading: 3, bluesky: 1`). `C = 2` flattens the curve in the first two hours so a 10-minute-old podcast doesn't bury a 90-minute-old film review. **Tune by editing the weight constants in `lib/db.ts`** — only the ratios matter. Category-filtered queries (`/api/items?category=music`) deliberately skip ranking and sort by `published_at DESC`.

### Item metadata column
JSON blob, schema varies by type:
- Podcast: `{ show_name, duration, audio_url, artwork_url, apple_id }`
- Bluesky: `{ handle, avatar_url, like_count, reply_count, repost_count }`
- RSS: `null`

### Config is the source of truth
`config/feeds.yml` is the admin panel (not in git — only `config/feeds.example.yml` is committed). Adding/removing a source from the YAML and waiting for the next poll cycle (or hitting Refresh) is all that's needed — `fetchAllSources` upserts new sources and deletes removed ones plus their items and item_state in a single transaction.

### Path alias
`tsconfig.json` maps `@/*` to the project root. Always import via `@/lib/...`, `@/components/...`, etc.

### Styling note
The codebase mixes inline styles (in `FeedCard`, `FeedClient`, `layout.tsx`) with a configured Tailwind setup. Tailwind is wired up but most components use inline styles for the dark theme. When editing existing components, match the surrounding style approach rather than introducing the other.

### Deployment
- PM2 on Mac Mini (`ecosystem.config.js`, app name `the-feed`, port 3000)
- `scripts/deploy.sh` is a cron-based auto-deploy script (every 2 min, pulls and restarts only if there are new commits)
- Files that live only on the Mini and are never committed: `config/feeds.yml`, `.env`, `data/the-feed.db`

### Environment variables
- `BLUESKY_IDENTIFIER` — Bluesky handle (e.g. `keithadair.com`)
- `BLUESKY_APP_PASSWORD` — Bluesky app password (not account password)

Bluesky sources will silently fail (logged to console) if these are missing — RSS/podcast sources still work without them.

### Git auth
The repo pushes via HTTPS with a PAT stored in `~/.git-credentials`. SSH doesn't work in this session because the SSH agent routes through 1Password which isn't accessible from Claude Code's shell.
