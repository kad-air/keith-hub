# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**The Feed** — a self-hosted personal content hub. Next.js 14 App Router + SQLite + Tailwind, installable as an iOS PWA. Runs on a Mac Mini, accessible via Tailscale only. Single user, no auth.

See `PRODUCT_PLAN.md` for product vision and design principles. The most load-bearing ones: **finite, not infinite** (no infinite scroll — you reach the end and stop), **triage, not consumption** (scan/save/dismiss here, consume in native apps), and **config over UI** (sources are managed by editing `config/feeds.yml` — there's no admin screen).

## Commands

```bash
npm run dev        # Start dev server (http://localhost:3000)
npm run build      # Production build (run before committing to verify types)
npm run start      # Start production server
npm run lint       # next lint — not enforced in CI, but available
```

No test suite. `npm run build` is the type-check gate — always run it before pushing.

## Runtime debugging — `scripts/inspect.mjs`

**Reach for this BEFORE poking sqlite or curl by hand.** It's a read-only CLI that tells you the actual state of the running Feed: items in the DB, parsed metadata, configured sources, what the live HTML actually rendered.

```bash
node scripts/inspect.mjs help                    # full command list
node scripts/inspect.mjs counts                  # category × state breakdown + bsky rich-content rollup
node scripts/inspect.mjs items <cat> [filter]    # tabular item list (--unread default; also --read --saved --all --limit N)
node scripts/inspect.mjs item <id-prefix>        # full row + parsed metadata for one item
node scripts/inspect.mjs sources                 # configured sources, item counts, last fetch
node scripts/inspect.mjs bsky-rich [kind]        # find bsky items with images/external/quoted/reply/repost
node scripts/inspect.mjs html [path]             # fetch live page, count rendered structural elements
node scripts/inspect.mjs logs [n]                # last N pm2 log lines for the-feed
node scripts/inspect.mjs refresh                 # POST /api/refresh and report
```

The `html` command is the closest thing to visual verification — it counts feed cards, author avatars, embed images, external link cards, quoted post cards, reply contexts, repost banners, and manifest links in the SSR'd output. Use it after a rendering change to confirm the fix actually shipped without having to ask for a phone test.

Standard "the user reports a bug" workflow:
1. `inspect.mjs counts` to orient
2. `inspect.mjs items <cat>` or `bsky-rich <kind>` to find the actual item
3. `inspect.mjs item <id>` to see its data and parsed metadata
4. Make the fix → `npm run build && pm2 restart the-feed`
5. `inspect.mjs html` to verify the rendered output reflects the change
6. **Then** ask the user to test on the phone

## Architecture

### Data flow
1. On first page load, `app/page.tsx` calls `ensureInitialized()` (lib/init.ts) which starts the background polling loop
2. The poller calls `fetchAllSources()` (lib/fetcher.ts) on an interval, which re-reads `config/feeds.yml` each cycle, syncs the `sources` table, fetches new content, and **auto-prunes any sources/items removed from config**
3. The page queries SQLite directly (not via API) for the initial SSR render, then the client uses `/api/items` for filtering/refresh

### Database schema (three tables)
- `sources` — mirrors `config/feeds.yml`; rewritten every poll cycle
- `items` — fetched content, unique on `(source_id, external_id)` so re-fetches are idempotent
- `item_state` — per-item user state: `read_at`, `saved_at`, `consumed_at`, `notes`. Rows are created lazily on first interaction, so **`LEFT JOIN item_state` is the correct join** (an inner join would hide untouched items)

`read_at` and `consumed_at` mean different things on purpose:
- `read_at` — "removed from the main feed". Set by dismiss, save (when toggling on), AND open.
- `consumed_at` — "the user actually clicked through and read it". Set ONLY by `/api/items/[id]/open`. The `/read` view queries on this so dismissals don't pollute the history.

### Three views, three queries
- **Main feed (`/`)** — items where `read_at IS NULL`. Marking read is how items leave.
- **Saved (`/saved`)** — items where `saved_at IS NOT NULL`, ordered by `saved_at DESC`.
- **Read history (`/read`)** — items where `consumed_at IS NOT NULL`, ordered by `consumed_at DESC`. Append-only history of things the user actually opened. Re-opening from /read bumps `consumed_at` so the item moves to the top. ReadClient passes no `onDismiss`, so FeedCard hides the dismiss button and left-swipes snap back instead of being destructive.

### Feed filtering invariants
- The "All" view uses the **hyperbolic ranked sort** in `RANKED_ORDER` (lib/db.ts): `score = weight / (age_hours + C)` where `C = 2` flattens the curve in the first couple of hours. Current weights: podcasts 8, music/film 6, reading 3, bluesky 1. Tune in the `WEIGHTS` const in lib/db.ts, not in callers.
- **Category-filtered views use pure recency** (`ORDER BY published_at DESC`), not the ranked sort — see `app/api/items/route.ts`. Intentional: ranking only makes sense when categories are competing.
- **Saving auto-marks-read** (`app/api/items/[id]/save/route.ts`): the save endpoint sets both `saved_at` and `read_at` when toggling on, so saved items leave the main feed and live in `/saved`. Each item gets a verdict — this is the triage principle. Unsaving does NOT touch `read_at` (the item stays read).
- **Opening auto-marks-read AND consumed** (`app/api/items/[id]/open/route.ts`): `handleOpen` in all three view clients calls `/open` which sets both `read_at` and `consumed_at` in one upsert. Dismiss flows still call `/read` (no consumed_at) so the history view stays clean.
- Per-category counts come from `getCategoryCounts(db)` in `lib/queries.ts` — a single grouped query returned alongside `/api/items` results so the tabs can show `READING · 12` etc.

### Key files
- `lib/db.ts` — SQLite singleton via `better-sqlite3` (synchronous). DB lives at `data/the-feed.db`. Also exports `RANKED_ORDER` (the SQL fragment for the "All" feed's weighted hyperbolic decay sort)
- `lib/queries.ts` — shared read queries (currently `getCategoryCounts`)
- `lib/config.ts` — YAML config parser. `invalidateConfig()` is called each poll cycle so `feeds.yml` changes take effect without restart
- `lib/fetcher.ts` — RSS/podcast fetcher. Also calls `fetchBlueskySource` for Bluesky sources. Mirrors the bluesky.ts upsert pattern: `INSERT … ON CONFLICT DO UPDATE` on `title`/`body_excerpt`/`image_url`/`metadata` so a future title-extractor or rewriter improvement backfills existing in-window rows on the next poll. New-row counting uses an explicit existence check. Hosts **source-specific title rewriters** (`rewritePitchforkAlbumTitle`, `rewriteAllMusicAlbumTitle`) for music album reviews — Pitchfork's RSS only ships the album name (artist is parsed out of the URL slug), AllMusic's title wraps the artist in an `<a>` tag that rss-parser strips (artist comes from `media:credit role="musician"`, album from `media:title`, exposed via the parser's `customFields`). Both rewriters only fire when `source.id` matches AND the URL matches the album review path, so blog posts / newsletters keep their normal titles. Adding a new source-specific rewriter is the right pattern for any future feed that's similarly mangled. Also hosts **per-source item filters**: `shouldKeepRssItem` is an allow-list applied at ingest, and `rssCleanupWhereClause` is its SQL counterpart applied as a self-healing prune after every fetch (deletes from `item_state` first because the FK has no `ON DELETE CASCADE`). Currently used to keep AllMusic's album-reviews-only (its RSS feed mixes in interviews, blog posts, and a weekly newsletter). The two functions must stay in sync for any source they cover.
- `lib/bluesky.ts` — AT Protocol fetcher using `@atproto/api`. Authenticates once, re-auths on session expiry. Extracts the rich `BlueskyMetadata` shape (see "Item metadata" below) from `app.bsky.embed.*` views and `feedViewPost.reply` / `feedViewPost.reason`. **Uses `INSERT … ON CONFLICT DO UPDATE` on the content fields** (`body_excerpt`, `image_url`, `metadata`) so re-fetches of in-window posts pick up extractor improvements without losing the row's id (which would orphan `item_state`). New-post counting does an explicit existence check first because UPDATE and INSERT both report `changes=1` in SQLite.
- `lib/types.ts` — shared types including `BlueskyMetadata` and its sub-shapes (`BlueskyImage`, `BlueskyExternalCard`, `BlueskyQuotedPost`, `BlueskyReplyContext`, `BlueskyRepostContext`). Read by both `lib/bluesky.ts` (writer) and `components/FeedCard.tsx` (reader).
- `lib/groupByDate.ts` — buckets items into Today / Yesterday / This week / Earlier (preserves input order within buckets, so the caller's sort wins)
- `lib/useKeyboard.ts` — keyboard shortcut hook with single-key + chord (`g h`) support. Ignores typing in inputs and any modifier-key combo (preserving cmd/ctrl shortcuts)
- `components/FeedCard.tsx` — renders all item types in three magazine variants (article, bluesky post, podcast). Bluesky cards are rendered by the `BlueskyBody` subcomponent with helpers `ReplyContext`, `ImageGrid` (1/2/3/4+ layouts respecting aspect ratios), `ExternalCard`, `QuotedPost`. The `forwardRef` now points to the **swipe wrapper div**, not the inner article — see "Touch UX" below. Podcasts tap to Apple Podcasts via `apple_id`.
- `components/FeedClient.tsx` — main feed page-level state, keyboard shortcuts, refresh, dismiss/save/undo/swipe flow, pull-to-refresh
- `components/SavedClient.tsx` / `components/ReadClient.tsx` — analogous clients for `/saved` and `/read`. ReadClient has no dismiss action (history is read-only) and FeedCard hides the dismiss button when `onDismiss` is omitted.
- `components/Toast.tsx` — undo toast with countdown progress bar; bottom anchor respects iOS safe-area-inset so it clears the home indicator
- `components/KeyboardHelp.tsx` — `?` overlay listing shortcuts. **Source of truth for the user-facing keyboard list.**
- `components/ServiceWorkerRegister.tsx` — registers the Serwist-generated SW on the client

### Touch UX — swipe gestures
On touch devices, action buttons are hidden entirely (`@media(hover:none)` override on the action row plus `pointer-events-none`). Save/dismiss are done via horizontal swipe on a card:

- The card body lives inside an `overflow-hidden` wrapper. Two action background panels sit underneath the article: save (accent-tinted, left) and dismiss (rule-tinted, right). The action panels render only when `dx` crosses the detect threshold so incidental motion doesn't flash them.
- `touchstart` records start position. `touchmove` decides horizontal vs vertical on first significant motion (>6px). If vertical wins, the gesture aborts and the page scrolls. If horizontal wins, the article translates 1:1 with the finger.
- `touch-action: pan-y` on the article so the browser still owns vertical scroll — no preventDefault gymnastics or passive-listener workarounds needed.
- Past 80px commit threshold the action background icon brightens to preview commit. On release past threshold, the article animates the rest of the way off-screen (200ms ease-out) and fires `onSave`/`onDismiss` when the animation completes. Below threshold it snaps back.
- A `wasSwipedRef` guards the `onClick` handler so a swipe gesture doesn't also count as a tap. Below the detect threshold the gesture never locks, so taps fall through normally.
- The keyboard-focus left-edge accent rule lives on the wrapper (not the article) so it doesn't slide along during a swipe.
- Tunable constants live at the top of `FeedCard.tsx`: `SWIPE_DETECT_THRESHOLD`, `SWIPE_COMMIT_THRESHOLD`, `COMMIT_ANIM_MS`.

Desktop hover behavior is unchanged: action buttons in the top-right corner appear on hover/keyboard focus.

### Visual identity
- Fonts loaded via `next/font/google` in `app/layout.tsx`: **Newsreader** (display + body, variable serif) and **JetBrains Mono** (kickers, badges, timestamps). Both exposed as CSS vars `--font-display` / `--font-mono` and aliased in `tailwind.config.ts` as `font-display` / `font-mono`
- Theme tokens live in `tailwind.config.ts` (`ink`, `cream`, `rule`, `accent`, per-category `cat.*`). Don't hardcode hexes in components — extend the theme

### API routes
- `GET  /api/items?category=&limit=&offset=` — lists unread items, ranked for "all", recent for categories. Response includes `counts: CategoryCounts` for the tab labels
- `POST /api/items/[id]/read` — marks read (upserts `item_state.read_at`). Used by dismiss flows
- `POST /api/items/[id]/open` — marks BOTH `read_at` AND `consumed_at`. Used by open flows. **Distinct from /read** so the /read history view can distinguish "I clicked this" from "I dismissed this"
- `POST /api/items/[id]/unread` — clears `read_at` (used by undo)
- `POST /api/items/[id]/save` — toggles saved. **When toggling on, also sets `read_at`** so the item leaves the main feed
- `POST /api/items/read-bulk` — body `{ ids: string[], unread?: boolean }`. Bulk mark-read in a single transaction. Used by "Dismiss all" and bulk undo
- `POST /api/refresh` — forces an immediate `fetchAllSources()` run

### Keyboard shortcuts
Defined in `components/FeedClient.tsx` (and subsets in `SavedClient.tsx` / `ReadClient.tsx`). Source of truth for the user-facing list is `components/KeyboardHelp.tsx`. Keys: `j`/`k` nav, `o`/`enter` open, `s` save, `x`/`e` dismiss, `r` refresh, `g h` / `g s` / `g r` go home/saved/read, `?` toggle help.

### Source types in config
- `type: rss` / `type: podcast` — both use the RSS fetcher; podcasts additionally parse `itunes:*` fields and store `apple_id`, `duration`, `artwork_url` in the `metadata` JSON column
- `type: bluesky` with `mode: feed` + `feed_uri` — fetches a specific Bluesky algorithmic feed (e.g. "Popular With Friends")
- `mode: account` + `handle` — individual Bluesky accounts. Currently uses `posts_no_replies` filter so reply context never appears for these sources
- `mode: timeline` — the authenticated user's home timeline

### Config is the source of truth
`config/feeds.yml` is the admin panel (not in git — only `config/feeds.example.yml` is committed). Adding/removing a source from the YAML and hitting browser refresh is all that's needed — the next poll cycle syncs the DB automatically.

### Item metadata (the JSON blob)
The `metadata` column is a JSON blob. Schema varies by type:

- **Podcast**: `{ show_name, duration, audio_url, artwork_url, apple_id }`
- **Bluesky**: `BlueskyMetadata` from `lib/types.ts`. Always has `handle`, `avatar_url`, `like_count`, `reply_count`, `repost_count`. Optionally has `display_name`, `images[]` (with `thumb`/`fullsize`/`alt`/`aspect_ratio`), `external{}` (link card with `url`/`title`/`description`/`thumb`/`domain`), `quoted{}` (a nested post that may itself have images and an external link), `reply_to{}` (parent author + truncated text), `reposted_by{}` (the reposter when the post appears via a repost). The Bluesky fetcher extracts these from the `app.bsky.embed.*` and `feedViewPost.reply`/`reason` fields. Older rows that aged out of the source feed before the rich extractor was added still have the old shape — the renderer treats all rich fields as optional so old and new rows render fine.

## PWA setup (read this before touching app/layout.tsx)

The Feed is installable as an iOS PWA. There are TWO non-obvious gotchas baked into the code that are easy to undo by accident:

### 1. Manifest link is hand-rolled, not via metadata.manifest

Next.js 14.2.3 hardcodes `crossOrigin="use-credentials"` on the metadata-generated `<link rel="manifest">` tag (see `node_modules/next/dist/lib/metadata/generate/basic.js`). iOS Safari **silently fails** to fetch a manifest with that attribute, so "Add to Home Screen" produces a regular bookmark instead of a real PWA install. There's no way to disable the attribute through the metadata API.

The workaround:
- Serve the manifest as a static file at `public/manifest.webmanifest` (NOT `app/manifest.ts` — Next.js auto-discovers `app/manifest.*` and injects the same broken link tag)
- Emit `<link rel="manifest" href="/manifest.webmanifest" />` directly inside `<head>` in `app/layout.tsx`
- Do NOT set `metadata.manifest`

Verify with: `node scripts/inspect.mjs html` — should show exactly one manifest link tag with no `crossorigin` attribute.

### 2. Opening external links uses an anchor click, not window.open

iOS standalone PWAs have a long-standing quirk: `window.open(url, "_blank")` opens the URL in BOTH Safari AND an in-PWA SFSafariViewController-style overlay. The fix is to programmatically click an `<a target="_blank">` element instead — iOS treats that as a clean handoff. The pattern is duplicated in `FeedClient.handleOpen`, `SavedClient.handleOpen`, and `ReadClient.handleOpen`. If you add another view that opens links, copy the pattern.

(Note: even after this fix, links still open in iOS's in-app SFSafariViewController-style browser, not Safari proper. That's the iOS 16.4+ standard for PWAs and there's no clean API to override it.)

### Service worker
- `app/sw.ts` is the Serwist source, compiled to `public/sw.js` at build time by `@serwist/next` (configured in `next.config.mjs`). The generated files are gitignored.
- `components/ServiceWorkerRegister.tsx` registers the SW on the client.
- `skipWaiting: true` and `clientsClaim: true` mean a fresh build replaces the previous SW on next launch — but iOS PWAs may need a force-quit (not just close) to actually pick up the new bundle.

## Deployment

**This repo runs ON the Mac Mini that is also the dev environment.** There's no separate prod server — `git push` is for backup, the local working tree IS what users hit.

- Process manager: PM2, process name **`the-feed`** (NOT `keith-hub`). Restart with `pm2 restart the-feed`. Logs at `~/.pm2/logs/the-feed-out-0.log` and `the-feed-error-0.log`.
- `ecosystem.config.js` sets `PORT=3030` and `HOSTNAME=0.0.0.0`. Port 3030 (not 3000) because the Mac Mini MCP server (`/Users/keithadair/Code/mac-mini-mcp-server`) owns 127.0.0.1:3000 on the same machine. `HOSTNAME=0.0.0.0` forces Next.js to bind on IPv4 — its default `::` is IPv6-only on macOS, and Tailscale Serve proxies via 127.0.0.1.
- Tailnet exposure: `tailscale serve --bg --https=10000 http://localhost:3030` (set out of band, not in repo). Reachable at `https://keiths-mac-mini-1110.tail846fa.ts.net:10000` from Tailscale-connected devices only — not public Funnel.
- `scripts/deploy.sh` is a cron-based auto-deploy (runs every 2 min, pulls and restarts only if there are new commits). Useful when committing from a different machine; redundant when editing on the Mini directly.
- Files that live only on the Mini and are never committed: `config/feeds.yml`, `.env`, `data/the-feed.db`

## Environment variables
- `BLUESKY_IDENTIFIER` — Bluesky handle (e.g. `keithadair.com`)
- `BLUESKY_APP_PASSWORD` — Bluesky app password (not account password)

## Git auth
The repo pushes via HTTPS with a PAT stored in `~/.git-credentials`. SSH doesn't work in this session because the SSH agent routes through 1Password which isn't accessible from Claude Code's shell. The `git push` command will print a benign `failed to store: -25308` warning from `git-credential-osxkeychain` — that's a Keychain access denial, NOT a push failure. Check the `<old>..<new>  main -> main` line to confirm the push actually happened.
