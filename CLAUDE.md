# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**The Feed** — a self-hosted personal content hub. Next.js 14 App Router + SQLite + Tailwind. Runs on a Mac Mini, accessible via Tailscale only. Single user, no auth.

## Commands

```bash
npm run dev        # Start dev server (http://localhost:3000)
npm run build      # Production build (run before committing to verify types)
npm run start      # Start production server
```

No test suite. No linter configured. `npm run build` is the type-check gate — always run it before pushing.

## Architecture

### Data flow
1. On first page load, `app/page.tsx` calls `ensureInitialized()` (lib/init.ts) which starts the background polling loop
2. The poller calls `fetchAllSources()` (lib/fetcher.ts) on an interval, which re-reads `config/feeds.yml` each cycle, syncs the `sources` table, fetches new content, and **auto-prunes any sources/items removed from config**
3. The page queries SQLite directly (not via API) for the initial SSR render, then the client uses `/api/items` for filtering/refresh

### Key files
- `lib/db.ts` — SQLite singleton via `better-sqlite3` (synchronous). DB lives at `data/the-feed.db`
- `lib/config.ts` — YAML config parser. `invalidateConfig()` is called each poll cycle so `feeds.yml` changes take effect without restart
- `lib/fetcher.ts` — RSS/podcast fetcher. Also calls `fetchBlueskySource` for Bluesky sources
- `lib/bluesky.ts` — AT Protocol fetcher using `@atproto/api`. Authenticates once, re-auths on session expiry
- `components/FeedCard.tsx` — renders all item types. Bluesky posts have no title (body text is primary). Podcasts tap to Apple Podcasts show page via `apple_id`

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
