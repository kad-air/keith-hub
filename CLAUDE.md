# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**The Feed** — a personal content hub. Next.js 14 App Router + SQLite + Tailwind, installable as an iOS PWA. Hosted on Railway at `hub.keithadair.com`. Single user, password-protected via middleware.

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
node scripts/inspect.mjs logs [n]                # last N log lines (Railway: use dashboard; local: pm2 logs)
node scripts/inspect.mjs refresh                 # POST /api/refresh and report
```

The `html` command is the closest thing to visual verification — it counts feed cards, author avatars, embed images, external link cards, quoted post cards, reply contexts, repost banners, and manifest links in the SSR'd output. Use it after a rendering change to confirm the fix actually shipped without having to ask for a phone test.

Standard "the user reports a bug" workflow:
1. `inspect.mjs counts` to orient
2. `inspect.mjs items <cat>` or `bsky-rich <kind>` to find the actual item
3. `inspect.mjs item <id>` to see its data and parsed metadata
4. Make the fix → `npm run build` → push to main (Railway auto-deploys)
5. `inspect.mjs html` to verify the rendered output reflects the change (uses `FEED_BASE` env var or `--password` flag for auth)
6. **Then** ask the user to test on the phone

## Architecture

### Data flow
1. On server boot, `instrumentation.ts` starts the background polling loop (via `startPolling` from `lib/fetcher.ts`)
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
- **Time-based falloff** (`UNREAD_TTL_HOURS` in `lib/queries.ts`). After every poll cycle, `pruneExpiredUnread` marks RSS items older than their category's TTL as read. RSS categories (music, books, film, podcasts, reading) have a 7-day TTL. Bluesky uses a **position-based window** (`BSKY_WINDOW`) instead of a TTL — see the All view invariant below. `consumed_at` is NEVER set by the prune, so /read history is unaffected. Pruned items are "pending": still in `items`, with `item_state.read_at` set, invisible to every view. A separate universal retention step (`READ_RETENTION_HOURS`, 7 days) then **hard-deletes** any item where `read_at` is set but `saved_at` and `consumed_at` are both null — i.e., silently dismissed items that the user never engaged with. Saved items and opened items live forever so `/saved` and `/read` are complete histories.
- **All view = every unread RSS item + bluesky sprinkled in.** `getMainFeedItems` fetches all unread items from each RSS category (music, books, film, podcasts, reading) with no cap — the TTL prune is the only bound. Bluesky is derived from the RSS total: `1 bsky per BSKY_INTERLEAVE_RATIO (4) RSS items`, with a minimum of 10 and a fallback of `BSKY_WINDOW (100)` when there are no RSS items. The bsky posts are selected via surprise sampling (`selectWithSurprise` using `SURPRISE_POOL_MULTIPLIER` and `SURPRISE_RECENCY_BIAS`) for variety within the newest posts. **Bluesky backlog is position-bounded**: `pruneExpiredUnread` keeps only the newest `BSKY_WINDOW` unread bsky posts and **hard-deletes** older ones (unless the user saved or opened them — those are preserved so `/saved` and `/read` stay correct). Deletion is used instead of mark-read because bsky volume is high; mark-read would bloat the `items` table indefinitely. Effect: a dismiss-all clears the window, and the next poll only surfaces genuinely-new posts — it does NOT dig deeper into the backlog.
- **Priority-weighted interleave.** `interleaveByPriority` uses stride scheduling with categories sorted by `ALL_VIEW_PRIORITY` descending. Priority weights: reviews (music/books/film) = 4, podcasts = 3, reading (Verge) = 2, bluesky = 1. Higher priority categories get earlier phase offsets so their items appear first/denser. `INTERLEAVE_JITTER` (0.35) perturbs positions mildly. The output is **NOT sorted by `published_at`** — the interleave pattern prevents category clumping.
- **No hard feed size limit.** `MAIN_FEED_LIMIT = 2000` in `app/page.tsx` and `FEED_LIMIT = 2000` in `components/FeedClient.tsx` are safety ceilings — keep them in sync. The `/api/items` endpoint caps `limit` at 2000. The actual feed size is determined by the TTL (7 days of RSS content + proportional bluesky).
- **Category-filtered views use pure recency** (`ORDER BY published_at DESC`), not the interleave logic — see `app/api/items/route.ts`.
- **All count reflects actual All view composition.** `getCategoryCounts` returns `all = totalRss + bskyContribution`, where bsky contribution mirrors the derivation logic in `getMainFeedItems`. Per-category counts are literal unread totals (already bounded by the TTL prune). The Bluesky tab hides its count badge entirely.
- Note: `RANKED_ORDER` (the hyperbolic decay sort) is no longer used by the All view but is still exported from `lib/db.ts` in case anything else wants it.
- **Saving auto-marks-read** (`app/api/items/[id]/save/route.ts`): the save endpoint sets both `saved_at` and `read_at` when toggling on, so saved items leave the main feed and live in `/saved`. Each item gets a verdict — this is the triage principle. Unsaving does NOT touch `read_at` (the item stays read).
- **Opening auto-marks-read AND consumed** (`app/api/items/[id]/open/route.ts`): `handleOpen` in all three view clients calls `/open` which sets both `read_at` and `consumed_at` in one upsert. Dismiss flows still call `/read` (no consumed_at) so the history view stays clean.
- **Bulk dismiss is NOT "marked as read"** (`POST /api/items/read-all`, called by the "That's enough for now." button at the bottom of the feed). The handler `markAllUnreadAsRead` in `lib/queries.ts` only sets `read_at`, never `consumed_at`. Bulk-dismissed items do NOT appear in `/read`. Same invariant applies to `pruneExpiredUnread` — auto-pruning is conceptually a bulk dismiss. Don't conflate the two — a future change that bulk-sets `consumed_at` would dump thousands of items the user never opened into the history view.

### Key files
- `lib/db.ts` — SQLite singleton via `better-sqlite3` (synchronous). DB lives at `data/the-feed.db`. Also exports `RANKED_ORDER` (a SQL fragment for weighted hyperbolic decay sort — not used by the All view but still available)
- `lib/queries.ts` — All view algorithm (`getMainFeedItems`, `interleaveByPriority`, `selectWithSurprise`), TTL pruning (`pruneExpiredUnread`), category counts (`getCategoryCounts`), bulk dismiss (`markAllUnreadAsRead`). All tunable knobs (`UNREAD_TTL_HOURS`, `ALL_VIEW_PRIORITY`, `BSKY_INTERLEAVE_RATIO`, `SURPRISE_*`, `INTERLEAVE_JITTER`) live at the top of this file
- `lib/config.ts` — YAML config parser. `invalidateConfig()` is called each poll cycle so `feeds.yml` changes take effect without restart
- `lib/fetcher.ts` — RSS/podcast fetcher. Also calls `fetchBlueskySource` for Bluesky sources. Mirrors the bluesky.ts upsert pattern: `INSERT … ON CONFLICT DO UPDATE` on `title`/`body_excerpt`/`image_url`/`metadata` so a future title-extractor or rewriter improvement backfills existing in-window rows on the next poll. New-row counting uses an explicit existence check. Calls `pruneExpiredUnread` at the end of every cycle (see Feed filtering invariants). Hosts **source-specific title rewriters** (`rewritePitchforkAlbumTitle`, `rewriteAllMusicAlbumTitle`) for music album reviews — Pitchfork's RSS only ships the album name (artist is parsed out of the URL slug), AllMusic's title wraps the artist in an `<a>` tag that rss-parser strips (artist comes from `media:credit role="musician"`, album from `media:title`, exposed via the parser's `customFields`). The Pitchfork rewriter is intentionally lenient about how it matches the album slug to the URL: it strips quotes/apostrophes (Pitchfork drops them entirely, e.g. `Wak'a` → `waka`) and tries multiple candidate slugs with common suffixes (`-ep`, `-lp`, `-album`, `-deluxe`, `-edition`, `-mixtape`) appended or stripped, picking the longest match. Both rewriters only fire when `source.id` matches AND the URL matches the album review path, so blog posts / newsletters keep their normal titles. Adding a new source-specific rewriter is the right pattern for any future feed that's similarly mangled. Also hosts **per-source item filters**: `shouldKeepRssItem` is an allow-list applied at ingest, and `rssCleanupWhereClause` is its SQL counterpart applied as a self-healing prune after every fetch (deletes from `item_state` first because the FK has no `ON DELETE CASCADE`). Currently used to keep AllMusic's album-reviews-only (its RSS feed mixes in interviews, blog posts, and a weekly newsletter). The two functions must stay in sync for any source they cover.
- `lib/bluesky.ts` — AT Protocol fetcher using `@atproto/api`. Authenticates once, re-auths on session expiry. Extracts the rich `BlueskyMetadata` shape (see "Item metadata" below) from `app.bsky.embed.*` views and `feedViewPost.reply` / `feedViewPost.reason`. **Uses `INSERT … ON CONFLICT DO UPDATE` on the content fields** (`body_excerpt`, `image_url`, `metadata`) so re-fetches of in-window posts pick up extractor improvements without losing the row's id (which would orphan `item_state`). New-post counting does an explicit existence check first because UPDATE and INSERT both report `changes=1` in SQLite.
- `lib/types.ts` — shared types including `BlueskyMetadata` and its sub-shapes (`BlueskyImage`, `BlueskyExternalCard`, `BlueskyQuotedPost`, `BlueskyReplyContext`, `BlueskyRepostContext`). Read by both `lib/bluesky.ts` (writer) and `components/FeedCard.tsx` (reader).
- `lib/groupByDate.ts` — buckets items into Today / Yesterday / This week / Earlier (preserves input order within buckets, so the caller's sort wins)
- `lib/useKeyboard.ts` — keyboard shortcut hook with single-key + chord (`g h`) support. Ignores typing in inputs and any modifier-key combo (preserving cmd/ctrl shortcuts)
- `components/HeaderNav.tsx` — client-side nav for the sticky header. Uses `usePathname` for active states: feed links highlight white when active, tracker links show their category color. Feed links hidden on mobile (`hidden sm:inline`) — BottomNav handles mobile.
- `components/BottomNav.tsx` — mobile-only (`sm:hidden`) fixed bottom tab bar. Today / Saved / Read tabs + a Trackers popover that expands to show all 5 trackers with category-colored active dots. Active tab gets a 2px accent top stripe. Blur backdrop + safe area bottom padding for iOS home indicator.
- `components/FeedCard.tsx` — renders all item types in three magazine variants (article, bluesky post, podcast). Bluesky cards are rendered by the `BlueskyBody` subcomponent with helpers `ReplyContext`, `ImageGrid` (1/2/3/4+ layouts respecting aspect ratios), `ExternalCard`, `QuotedPost`. The `forwardRef` now points to the **swipe wrapper div**, not the inner article — see "Touch UX" below. Podcasts tap to Apple Podcasts via `apple_id`.
- `components/FeedClient.tsx` — main feed page-level state, keyboard shortcuts, refresh, dismiss/save/undo/swipe flow, pull-to-refresh
- `components/SavedClient.tsx` / `components/ReadClient.tsx` — analogous clients for `/saved` and `/read`. ReadClient has no dismiss action (history is read-only) and FeedCard hides the dismiss button when `onDismiss` is omitted.
- `components/TrackerClient.tsx` — tracker grid state, status-tab filtering, optimistic updates, keyboard navigation
- `components/TrackerCard.tsx` — individual tracker item card with cover image, title/subtitle, release date, and inline edit controls (status, rating, ranking)
- `components/Toast.tsx` — undo toast with countdown progress bar; bottom anchor respects iOS safe-area-inset and clears the BottomNav on mobile
- `components/KeyboardHelp.tsx` — `?` overlay listing shortcuts. **Source of truth for the user-facing keyboard list.**
- `components/AppMenu.tsx` — gear icon dropdown with theme toggle (Auto/Light/Dark) and version info. Accessible from both mobile and desktop header.
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
- Theme tokens live in `tailwind.config.ts` (`ink`, `cream`, `rule`, `accent`, per-category `cat.*` for podcasts/music/books/film/reading/bluesky). Don't hardcode hexes in components — extend the theme

### API routes
- `GET  /api/items?category=&limit=&offset=` — lists unread items. The All view uses `getMainFeedItems` (see Feed filtering invariants): every unread RSS item + proportional bluesky. Categories use pure recency. `limit` is capped at 2000 server-side. Response includes `counts: CategoryCounts` for the tab labels
- `POST /api/items/[id]/read` — marks read (upserts `item_state.read_at`). Used by per-item dismiss flows
- `POST /api/items/[id]/open` — marks BOTH `read_at` AND `consumed_at`. Used by open flows. **Distinct from /read** so the /read history view can distinguish "I clicked this" from "I dismissed this"
- `POST /api/items/[id]/unread` — clears `read_at` (used by undo)
- `POST /api/items/[id]/save` — toggles saved. **When toggling on, also sets `read_at`** so the item leaves the main feed
- `POST /api/items/read-bulk` — body `{ ids: string[], unread?: boolean }`. Bulk mark-read or bulk-clear-read in a single transaction. Used by undo flows
- `POST /api/items/read-all` — body `{ category?: string }`. Bulk dismiss every unread item in scope (omit category for "everything"). Returns the affected IDs so the client can build an undo. Backs the "Dismiss all" footer button. **Sets only `read_at`, never `consumed_at`** — see the bulk-dismiss invariant above
- `POST /api/refresh` — forces an immediate `fetchAllSources()` run
- `GET  /api/push/subscribe` — returns `{ subscribed: boolean }`
- `POST /api/push/subscribe` — saves a Web Push subscription (body is the subscription JSON)
- `DELETE /api/push/subscribe` — removes the stored subscription
- `POST /api/push/test` — sends a test push notification (returns `{ sent: boolean }`)

### Keyboard shortcuts
Defined in `components/FeedClient.tsx` (and subsets in `SavedClient.tsx` / `ReadClient.tsx`). Source of truth for the user-facing list is `components/KeyboardHelp.tsx`. Keys: `j`/`k` nav, `o`/`enter` open, `s` save, `x`/`e` dismiss, `r` refresh, `g h` / `g s` / `g r` go home/saved/read, `?` toggle help.

### Source types in config
- `type: rss` / `type: podcast` — both use the RSS fetcher; podcasts additionally parse `itunes:*` fields and store `apple_id`, `duration`, `artwork_url` in the `metadata` JSON column
- `type: bluesky` with `mode: feed` + `feed_uri` — fetches a specific Bluesky algorithmic feed (e.g. "Popular With Friends")
- `mode: account` + `handle` — individual Bluesky accounts. Currently uses `posts_no_replies` filter so reply context never appears for these sources
- `mode: timeline` — the authenticated user's home timeline

### Config is the source of truth
`config/feeds.yml` is the admin panel (committed to git alongside `config/feeds.example.yml`). Adding/removing a source from the YAML and hitting browser refresh is all that's needed — the next poll cycle syncs the DB automatically. The config is re-read every cycle, so changes take effect without restart.

### Item metadata (the JSON blob)
The `metadata` column is a JSON blob. Schema varies by type:

- **Podcast**: `{ show_name, duration, audio_url, artwork_url, apple_id }`
- **Bluesky**: `BlueskyMetadata` from `lib/types.ts`. Always has `handle`, `avatar_url`, `like_count`, `reply_count`, `repost_count`. Optionally has `display_name`, `images[]` (with `thumb`/`fullsize`/`alt`/`aspect_ratio`), `external{}` (link card with `url`/`title`/`description`/`thumb`/`domain`), `quoted{}` (a nested post that may itself have images and an external link), `reply_to{}` (parent author + truncated text), `reposted_by{}` (the reposter when the post appears via a repost). The Bluesky fetcher extracts these from the `app.bsky.embed.*` and `feedViewPost.reply`/`reason` fields. Older rows that aged out of the source feed before the rich extractor was added still have the old shape — the renderer treats all rich fields as optional so old and new rows render fine.

### Tracker data (Craft.do collections)
Trackers are backed by Craft.do collections fetched via the Craft Connect API (`lib/craft.ts`). Each tracker is configured in `lib/tracker-config.ts` with a `collectionId`, display options, and field mappings. `normalizeItems` in `lib/craft.ts` maps raw Craft items into `TrackerItem` objects (`lib/craft-types.ts`).

**Release dates**: `normalizeItems` extracts `releaseDate` from Craft properties. Music, movies, TV, and games all have a `release_date` (date type) property. Books uses `publication_year` (number type) instead — displayed as just the year. `TrackerCard` formats dates as "Mon DD, YYYY" for full dates.

The Craft schema for each collection also includes extra fields not currently surfaced in the UI (e.g. `genre`, `synopsis`, `runtime_minutes`, `in_plex` for movies; `number_of_songs`, `genre` for music; `length_in_pages` for books; `season` for TV). These live in `item.properties` and can be accessed if needed.

### Push notifications (release date alerts)
Web Push via VAPID, powered by the `web-push` npm package. Single-user, so the subscription is stored in the SQLite `kv` table (key `push_subscription`).

**Flow:**
1. User taps "Enable release alerts" in AppMenu (gear icon). iOS prompts for notification permission (user gesture required). The browser creates a push subscription and POSTs it to `/api/push/subscribe`.
2. Every poll cycle (~15 min), `fetchAllSources` calls `checkReleaseNotifications()` from `lib/release-notify.ts`. A date guard (`data/release-notify-last.txt`) ensures it only runs once per calendar day.
3. The checker fetches all 5 Craft tracker collections, compares each item's `release_date` against today (YYYY-MM-DD), and sends a web push for any matches.
4. The service worker (`app/sw.ts`) handles `push` events (shows the notification) and `notificationclick` events (focuses or opens the app).

**Key files:**
- `lib/push.ts` — `getSubscription`, `saveSubscription`, `removeSubscription`, `sendPush` (backed by SQLite `kv` table)
- `lib/release-notify.ts` — `checkReleaseNotifications` (daily Craft scan + push dispatch, date guard in SQLite `kv` table)
- `app/api/push/subscribe/route.ts` — CRUD for the push subscription
- `app/api/push/test/route.ts` — `POST` sends a test notification
- `components/AppMenu.tsx` — "Release alerts" toggle button with permission state handling

**Environment variables:**
- `VAPID_PUBLIC_KEY` — also exposed to the client as `NEXT_PUBLIC_VAPID_PUBLIC_KEY` via `next.config.mjs`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT` — `mailto:` URI for VAPID identification

**Testing:** `curl -X POST http://localhost:3000/api/push/test` (requires an active subscription; in production, use the auth cookie or `inspect.mjs`).

### Comics — Marvel Unlimited reading orders
A static catalog of Hickman-era reading orders (X-Men, Avengers/Secret Wars), each issue tappable to hand off to the Marvel Unlimited iOS app. Two pages: `/comics` (storyline index) and `/comics/[slug]` (the checklist).

**Catalog is static, generated offline.** `lib/comics-data.ts` is auto-generated and committed; the app does not fetch from Marvel at runtime. Source data and the scraping/generation pipeline live in the sibling repo `~/Code/mu-reading-lists` — see `scripts/comics-data-pipeline.md` for how the per-issue `digitalBookId`, `drn`, and `sourceId` are sourced from the marvel.com sitemap, page HTML, and `bifrost.marvel.com/unison/legacy`. To regenerate after adding a storyline or refreshing data: `node scripts/generate-comics-data.mjs`. The script skips storylines whose applinks/drns aren't fully populated yet (resumable scrapes) so partial regenerations can't ship broken data.

**Read state lives in SQLite.** Table `comic_state` has one row per read issue (`issue_id` PK = `digitalBookId`, `read_at`). Routes: `POST /api/comics/[id]/read` and `POST /api/comics/[id]/unread`. The `/comics` index calls `getReadComicIds()` from `lib/queries.ts` to compute `read / total` per storyline.

**The Marvel Unlimited handoff is the load-bearing UX trick.** `read.marvel.com/#/book/{digitalBookId}` is the obvious URL but it's useless from inside the PWA — iOS routes `target="_blank"` clicks through SFSafariViewController, which doesn't honor universal links. The fix in `components/ComicsClient.tsx` is to link to `marvel.smart.link/fiir7ec77?type=issue&drn={drn}&sourceId={sourceId}` (Marvel's Branch.io deep-link host) **as a plain `<a>` with no `target` and no `preventDefault`**. iOS treats that as a top-level navigation and hands off to the app via the smart.link's app-claim. The PWA gets backgrounded; swiping back returns to the same scroll position.

**Important: do NOT replicate the FeedClient `target="_blank"` anchor pattern here.** The whole PWA-handoff section #2 below explicitly opens in the in-app browser — that's the wrong outcome for comics.

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

**Hosted on Railway** at `hub.keithadair.com`. Auto-deploys on push to `main`.

- Railway builds with Nixpacks (auto-detects Next.js). No Dockerfile needed.
- Railway sets `PORT` dynamically — Next.js respects it automatically.
- Persistent volume mounted at `/app/data` holds the SQLite database (all persistent state — items, push subscription, release-notify date — lives in the DB's `kv` table).
- The background poller starts on process boot via `instrumentation.ts` (Next.js instrumentation hook with `experimental.instrumentationHook: true` in `next.config.mjs`).
- Git version metadata: `next.config.mjs` tries `git rev-parse` first, falls back to Railway's `RAILWAY_GIT_COMMIT_SHA` env var.
- DNS: CNAME record `hub` → Railway's provided CNAME target, managed in DigitalOcean DNS. Domain registered at Squarespace.

### Auth
Password-protected via Next.js middleware (`middleware.ts`). A `hub-auth` httpOnly cookie (30-day expiry) gates all routes except the login page, static assets, manifest, and service worker. `FEED_PASSWORD` env var. Log out via gear menu.

The login/logout `POST` handlers (`app/api/auth/{login,logout}/route.ts`) must return **303** redirects, not the default 307. iOS Safari preserves the POST method on 307 and tries to POST to `/`, which fails with "Safari can't open the page because the address is invalid" until manual refresh.

### Local dev
The Mac Mini is still the dev environment. `npm run dev` on port 3000. The `.env` file holds the same env vars as Railway. If `FEED_PASSWORD` is unset, auth is bypassed (so local dev works without logging in).

### Files never committed
`.env`, `data/the-feed.db`

## Environment variables
- `FEED_PASSWORD` — password for the login gate (unset = auth bypassed, for local dev)
- `BLUESKY_IDENTIFIER` — Bluesky handle (e.g. `keithadair.com`)
- `BLUESKY_APP_PASSWORD` — Bluesky app password (not account password)
- `CRAFT_API_KEY` — Craft Connect API key for tracker collections
- `VAPID_PUBLIC_KEY` — Web Push VAPID public key (also exposed client-side as `NEXT_PUBLIC_VAPID_PUBLIC_KEY`)
- `VAPID_PRIVATE_KEY` — Web Push VAPID private key
- `VAPID_SUBJECT` — `mailto:` URI for VAPID identification

## Git auth
The repo pushes via HTTPS with a PAT stored in `~/.git-credentials`. SSH doesn't work in this session because the SSH agent routes through 1Password which isn't accessible from Claude Code's shell. The `git push` command will print a benign `failed to store: -25308` warning from `git-credential-osxkeychain` — that's a Keychain access denial, NOT a push failure. Check the `<old>..<new>  main -> main` line to confirm the push actually happened.
