# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**The Feed** — a personal content hub. Next.js 14 App Router + SQLite + Tailwind, installable as an iOS PWA. Hosted on Railway at `hub.keithadair.com`. Single user, password-protected via middleware.

Load-bearing design principles: **finite, not infinite** (no infinite scroll — you reach the end and stop), **triage, not consumption** (scan/save/dismiss here, consume in native apps), and **one config document** (everything about sources and the algorithm lives in a single YAML document — the **Tune** section at `/tune` is an editor over that document, and the repo's `config/feeds.yml` is its seed and backup; see "Config architecture"). See `README.md` for the user-facing description.

## Commands

```bash
npm run dev        # Start dev server (http://localhost:3000)
npm run build      # Production build (run before committing to verify types)
npm run start      # Start production server
npm run lint       # next lint — not enforced in CI, but available
npm run check:hoops              # Hoops read-model gate (runs automatically as `prebuild`)
npm run check:hoops:fixture      # Hoops cross-implementation engine fixture (same)
npm run check:hoops:multinomial  # numpy-parity gate on the box-score allocation (same)
npm run check:hoops:boxscore     # Box-score gate: integer identity + level anchors (same)
npm run check:tracking-hidden    # Tracking section stays hidden (needs a running server; NOT in prebuild)
npm run check:books:bytes        # Books byte-identity gate: partialMd5 vs offline Python reference, ingest stores untouched bytes (same)
npm run check:books:opds         # Books OPDS device-contract gate: CrossPoint parser constraints + the To Read shelf, anchored on Stump's device-proven feed (same)
npm run check:books:kosync       # Books kosync protocol gate: md5 wire auth, opaque progress round-trip, no-rollback import (same)
npm run check:books:metadata     # Books metadata gate: an edit never touches the file/sha256/partial_md5 (same)
npm run check:books:stats        # Books reading-stats gate: word count vs. Python, real DST calendar, sync survives a stats failure (same)
npm run check:books:drm          # Books DRM gate: an ADEPT epub is decrypted-or-refused (never the 34-page ghost); a clean epub passes through byte-identical (same)
```

No test suite. `npm run build` is the type-check gate — always run it before pushing. It is
**also** the data and engine gate: `prebuild` runs all five `check:hoops*` scripts, so a stale
blob, a TypeScript engine that disagrees with Python, a multinomial that disagrees with numpy, or
a box score whose player lines stop adding up fails the build (and the Railway deploy) rather than
shipping. See "Hoops" below.
**Requires Node >= 24** (`engines` + `.nvmrc`) — those gates execute TypeScript directly.

## Runtime debugging — `scripts/inspect.mjs`

**Reach for this BEFORE poking sqlite or curl by hand.** It's a read-only CLI that tells you the actual state of the running Feed: items in the DB, parsed metadata, configured sources, what the live HTML actually rendered.

```bash
node scripts/inspect.mjs help                    # full command list
node scripts/inspect.mjs counts                  # category × state breakdown + bsky rich-content rollup
node scripts/inspect.mjs items <cat> [filter]    # tabular item list (--unread default; also --read --saved --all --limit N)
node scripts/inspect.mjs item <id-prefix>        # full row + parsed metadata for one item
node scripts/inspect.mjs sources                 # configured sources, item counts, last fetch
node scripts/inspect.mjs bsky-rich [kind]        # find bsky items with images/video/external/quoted/reply/repost
node scripts/inspect.mjs html [path]             # fetch live page, count rendered structural elements
node scripts/inspect.mjs logs [n]                # last N log lines (Railway: use dashboard; local: pm2 logs)
node scripts/inspect.mjs refresh                 # POST /api/refresh and report
```

The `html` command is the closest thing to visual verification — it counts feed cards, author avatars, embed images, video embeds, YouTube embeds, external link cards, quoted post cards, reply contexts, repost banners, and manifest links in the SSR'd output. Use it after a rendering change to confirm the fix actually shipped without having to ask for a phone test.

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
2. The poller calls `fetchAllSources()` (`lib/fetcher.ts`) on an interval (`app.poll_interval_minutes` in `config/feeds.yml`, default 15), which re-reads `config/feeds.yml` each cycle, syncs the `sources` table, fetches new content, runs the Verge dedup, **auto-prunes any sources/items removed from config**, runs `pruneExpiredUnread`, and calls `checkReleaseNotifications` (which has its own once-per-local-day guard)
3. `app/page.tsx` queries SQLite directly (not via API) for the initial SSR render, then `FeedClient` uses `/api/items` for filtering/refresh. `app/layout.tsx` wraps everything in `ThemeProvider` and renders the `Masthead` globally; all navigation (sections AND the Feed/Saved/Read views) lives in the `Contents` overlay — there is no persistent sub-tab bar

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
- **Time-based falloff** (`UNREAD_TTL_HOURS` in `lib/queries.ts`). After every poll cycle, `pruneExpiredUnread` marks RSS items older than their category's TTL as read. RSS categories (music, books, film, tech_review, podcasts, reading) have a 7-day TTL. Bluesky uses a **position-based window** (`BSKY_WINDOW`) instead of a TTL — see the All view invariant below. `consumed_at` is NEVER set by the prune, so /read history is unaffected. Pruned items are "pending": still in `items`, with `item_state.read_at` set, invisible to every view. A separate universal retention step (`READ_RETENTION_HOURS`, 7 days) then **hard-deletes** any item where `read_at` is set but `saved_at` and `consumed_at` are both null — i.e., silently dismissed items that the user never engaged with. Saved items and opened items live forever so `/saved` and `/read` are complete histories.
- **All view = every unread RSS item + bluesky sprinkled in.** `getMainFeedItems` fetches all unread items from each RSS category (music, books, film, tech_review, podcasts, reading) with no cap — the TTL prune is the only bound. Bluesky is derived from the RSS total: `1 bsky per BSKY_INTERLEAVE_RATIO (4) RSS items`, with a minimum of 10. **When RSS is empty, bsky contribution is zero** — the All view goes empty. This is the "enough for now" invariant: dismiss-all settles the feed to empty instead of dumping the bsky backlog, which used to surface up to `BSKY_WINDOW` posts and felt like an infinite loop. Unread bsky is still fully accessible via the Bluesky tab (category filter, pure recency). The bsky posts for the All view are selected via surprise sampling (`selectWithSurprise` using `SURPRISE_POOL_MULTIPLIER` and `SURPRISE_RECENCY_BIAS`) for variety within the newest posts. **Bluesky backlog is position-bounded**: `pruneExpiredUnread` keeps only the newest `BSKY_WINDOW` unread bsky posts and **hard-deletes** older ones (unless the user saved or opened them — those are preserved so `/saved` and `/read` stay correct). Deletion is used instead of mark-read because bsky volume is high; mark-read would bloat the `items` table indefinitely.
- **Priority-weighted interleave.** `interleaveByPriority` uses stride scheduling with categories sorted by `ALL_VIEW_PRIORITY` descending. Priority weights: reviews (music/books/film/tech_review) = 4, podcasts = 3, reading (Verge articles + quickposts) = 2, bluesky = 1. Higher priority categories get earlier phase offsets so their items appear first/denser. `INTERLEAVE_JITTER` (0.35) perturbs positions mildly. The output is **NOT sorted by `published_at`** — the interleave pattern prevents category clumping.
- **Verge dedup.** Both `verge-full` (category `reading`) and `verge-reviews` (category `tech_review`) pull from overlapping Verge subscriber feeds. After RSS fetching, `fetchAllSources` removes any `verge-full` row whose URL also appears in `verge-reviews` — the review wins because `tech_review` has higher priority. Self-healing: the dedup runs every poll cycle and only fires when both sources are present in config.
- **No hard feed size limit.** `MAIN_FEED_LIMIT = 500` in `app/page.tsx` is a conservative SSR ceiling; `FEED_LIMIT = 2000` in `components/FeedClient.tsx` is the client-side refetch ceiling, which also matches the server cap in `/api/items` (2000). They intentionally diverge — the SSR payload stays small because progressive chunked rendering (see below) reveals cards incrementally anyway. The actual feed size is determined by the TTL (7 days of RSS content + proportional bluesky).
- **Progressive chunked rendering** (`FeedClient.tsx`). The feed renders `INITIAL_CHUNK = 50` cards up front and adds another `CHUNK_SIZE = 50` whenever an IntersectionObserver sentinel nears the viewport (`rootMargin: 600px`). `j` keyboard nav also expands the window when it would outrun the DOM. The chunk count resets to `INITIAL_CHUNK` whenever `items` changes (category switch, refresh). Keeps initial SSR + hydration cheap without giving up finite scroll.
- **Category tab cache.** `FeedClient` keeps an in-memory `Map` of `category → {items, counts, ts}` so rapid tab switching hits cache instead of the network. Entries older than 30s are treated as stale and refetched. Any mutation (open/save/dismiss/refresh) calls `invalidateCache()` so we never show stale state after a write.
- **Silent background refresh on PWA resume.** When `document.visibilitychange` fires and more than 60s has elapsed since the last manual refresh, `FeedClient` posts to `/api/refresh`, re-fetches counts, and diffs item IDs. If new items arrived AND the user is already at the top of the feed (`window.scrollY < 100` with nothing keyboard-focused below), the new list is applied silently — no toast, no jank, because there's no scroll position to preserve. If the user has scrolled or focused deeper, the update surfaces as a "Load now" toast instead, so their read position isn't yanked. **On the All view, bluesky rows are excluded from the new-items diff** — surprise sampling rotates which bsky posts appear on every query, so they'd register as "new" even when nothing was fetched; only RSS arrivals trigger the silent apply or the toast. `fetchAllSources` itself has a shared in-flight guard (`lib/fetcher.ts`), so concurrent callers — the 15-min poller, the visibility refresh, and a manual refresh — await the same crawl rather than racing and overwriting each other's responses.
- **No refresh button.** Manual refresh is pull-to-refresh on touch and `r` on desktop; the resume-refresh covers the ambient case. Results ("N new items" / "Up to date" / "Refresh failed") ride the shared toast slot with a short auto-dismiss. **The "N new items" count only includes items going to the active view**: `/api/refresh` returns the crawl's new-row count split as `{ fetched, rss, bluesky }` (`FetchSummary` from `lib/fetcher.ts`), and the toast uses `rss` everywhere except the Bluesky tab (which uses `bluesky`) — new bsky posts don't grow the All view, so a bsky-only crawl reads "Up to date". In-flight feedback depends on the initiator: a pull shows its own indicator zone (see Touch UX), so the "Refreshing…" toast renders only for non-pull refreshes (`pullPhase !== "refreshing"`). The PWA-resume path stays silent on success.
- **Keyboard hints are hidden below the `sm` breakpoint** (`max-sm:hidden`): the Contents chord legend + "Esc ·" prefix, the end-of-feed "Keyboard" button, and the /saved empty-state "Press s" line (which swaps to a swipe instruction). Width, not `hover:none`, is the deliberate discriminator — an iPad may have a hardware keyboard attached, so it keeps the hints.
- **Category-filtered views use pure recency** (`ORDER BY published_at DESC`), not the interleave logic — see `app/api/items/route.ts`.
- **All count reflects actual All view composition.** `getCategoryCounts` returns `all = totalRss + bskyContribution`, where bsky contribution mirrors the derivation logic in `getMainFeedItems`. Per-category counts are literal unread totals (already bounded by the TTL prune). The Bluesky tab hides its count badge entirely.
- Note: `RANKED_ORDER` (the hyperbolic decay sort) is no longer used by the All view but is still exported from `lib/db.ts` in case anything else wants it. It's kept in sync with the current category list (includes `tech_review`).
- **Saving auto-marks-read** (`app/api/items/[id]/save/route.ts`): the save endpoint sets both `saved_at` and `read_at` when toggling on, so saved items leave the main feed and live in `/saved`. Each item gets a verdict — this is the triage principle. Unsaving does NOT touch `read_at` (the item stays read).
- **Opening auto-marks-read AND consumed** (`app/api/items/[id]/open/route.ts`): `handleOpen` in all three view clients calls `/open` which sets both `read_at` and `consumed_at` in one upsert. Dismiss flows still call `/read` (no consumed_at) so the history view stays clean.
- **Bulk dismiss is NOT "marked as read"** (the "That's enough for now." footer button). The current client sends the specific visible IDs to `POST /api/items/read-bulk`, which only sets `read_at`, never `consumed_at`. Bulk-dismissed items do NOT appear in `/read`. `markAllUnreadAsRead` / `POST /api/items/read-all` still exist in `lib/queries.ts` for scoped "everything" dismissals and follow the same invariant. `pruneExpiredUnread` is conceptually a bulk dismiss too — don't conflate any of them with "consumed"; a future change that bulk-sets `consumed_at` would dump thousands of items the user never opened into the history view.
- **Clear above** (`c` keyboard shortcut on the focused card; long-press on touch; third hover button on desktop). `handleClearAbove` in `FeedClient.tsx` slices every item from the top of the feed down through the targeted one, calls `POST /api/items/read-bulk` with those IDs, snapshots the items for undo, and smooth-scrolls the viewport to the top once the cards are removed. Same invariant as bulk dismiss: read_at only, never consumed_at.

### Key files
- `lib/db.ts` — SQLite singleton via `better-sqlite3` (synchronous). DB lives at `data/the-feed.db`. Schema also includes `kv` (push subscription, release-notify date guard) and `comic_state` (per-issue read flag). Also exports `RANKED_ORDER` (a SQL fragment for weighted hyperbolic decay sort — not used by the All view but still available; kept in sync with the current category list including `tech_review`).
- `lib/queries.ts` — All view algorithm (`getMainFeedItems`, `interleaveByPriority`, `selectWithSurprise`), TTL pruning (`pruneExpiredUnread`), category counts (`getCategoryCounts`), bulk dismiss (`markAllUnreadAsRead`), and comics read-state helpers (`getReadComicIds`, `markComicRead`, `markComicUnread`). All tunable knobs now come from the config's `algorithm:` block via `getAlgorithm()` in `lib/config.ts` (defaults in `ALGORITHM_DEFAULTS` there) — editable live from the Tune section.
- `lib/config.ts` — the config layer: DB-backed YAML document (kv key `config_yaml`, seeded from `config/feeds.yml`), validation, `algorithm:` block resolution (`getAlgorithm()`, `ALGORITHM_DEFAULTS`), and the save/restore helpers behind `/api/tune/config`. `invalidateConfig()` is called each poll cycle so changes take effect without restart. See "Config architecture (Tune)".
- `lib/fetcher.ts` — RSS/podcast fetcher. Also calls `fetchBlueskySource` for Bluesky sources. Mirrors the bluesky.ts upsert pattern: `INSERT … ON CONFLICT DO UPDATE` on `title`/`body_excerpt`/`image_url`/`metadata` so a future title-extractor or rewriter improvement backfills existing in-window rows on the next poll. New-row counting uses an explicit existence check. Calls `pruneExpiredUnread` at the end of every cycle (see Feed filtering invariants). The per-item map is a `flatMap` so a single feed item can expand into multiple rows. Hosts the **Pitchfork title rewriter** (`rewritePitchforkAlbumTitle`) for music album reviews — Pitchfork's RSS only ships the album name, so artist is parsed out of the URL slug and prepended. The rewriter is intentionally lenient about matching the album slug to the URL: it strips quotes/apostrophes (Pitchfork drops them entirely, e.g. `Wak'a` → `waka`) and tries multiple candidate slugs with common suffixes (`-ep`, `-lp`, `-album`, `-deluxe`, `-edition`, `-mixtape`) appended or stripped, picking the longest match. Only fires when `source.id` matches AND the URL matches the album review path. Adding a new source-specific rewriter is the right pattern for any future feed that's similarly mangled. Also hosts **`parseAllMusicNewsletter`**: AllMusic's `/rss/newreleases` ships ONE weekly newsletter item whose `<description>` is an HTML `<ul>` of editor's-pick album rows; the parser walks each `<li>`, extracts the artist link, album link, and editor's note, and synthesizes one ItemRow per album. external_id is namespaced as `newsletter#<albumUrl>#<weekDate>` so it can never collide with rows left over from the legacy `/rss/all` "Album of the Day" ingest (whose external_ids were the bare album URL — those re-published the same URL daily and silently aliased into the dismissed row, which is why we moved off of it). After all RSS fetches, a **Verge dedup** step removes any `verge-full` row whose URL also appears in `verge-reviews` (see Feed filtering invariants).
- `lib/bluesky.ts` — AT Protocol fetcher using `@atproto/api`. Authenticates once, re-auths on session expiry. Extracts the rich `BlueskyMetadata` shape (see "Item metadata" below) from `app.bsky.embed.*` views and `feedViewPost.reply` / `feedViewPost.reason`. Also populates the post identity fields (`uri`, `cid`, `did`) and the `viewer` state (own `like_uri`, `repost_uri`, `following_uri`) so the Bluesky write endpoints can both mutate records and render accurate client state. Exposes `getBlueskyAgent` / `resetBlueskyAgent` for use by the write endpoints. **Uses `INSERT … ON CONFLICT DO UPDATE` on the content fields** (`body_excerpt`, `image_url`, `metadata`) so re-fetches of in-window posts pick up extractor improvements without losing the row's id (which would orphan `item_state`). New-post counting does an explicit existence check first because UPDATE and INSERT both report `changes=1` in SQLite.
- `lib/bsky-actions.ts` — shared helpers for the three Bluesky write endpoints (`/api/items/[id]/bsky-like|bsky-repost|bsky-follow`). `loadBlueskyItem(id)` hydrates + validates the metadata JSON, throwing a typed `BlueskyActionError` (404/400/409) when the row isn't a Bluesky post or is still missing its `uri`/`cid` from the pre-identity-backfill era. `saveBlueskyMetadata` persists the mutated metadata. `propagateFollowToSiblings` is the one extra wrinkle — on a successful follow, we sweep every other Bluesky item authored by the same DID and stamp their `viewer.following_uri` so their Follow chips hide too.
- `lib/auth.ts` — `deriveAuthToken(password)` derives a stable HMAC-SHA256 token from the env password. The middleware compares that token to the `hub-auth` cookie, so the raw password never leaves the server. Works in both Edge (middleware) and Node runtimes via Web Crypto. `publicUrl(path, request)` reconstructs the public origin from `x-forwarded-host` / `-proto` — required behind Railway's reverse proxy where `request.url` resolves to localhost.
- `lib/types.ts` — shared types including `BlueskyMetadata`, its sub-shapes (`BlueskyImage`, `BlueskyExternalCard`, `BlueskyQuotedPost`, `BlueskyReplyContext`, `BlueskyRepostContext`), and `BlueskyViewerState` for the own-record URIs. `CategoryCounts` is the source of truth for the full RSS+bluesky category set (currently `reading`, `tech_review`, `books`, `music`, `film`, `podcasts`, `bluesky`). Read by `lib/bluesky.ts` + the bsky-action endpoints (writers) and `components/FeedCard.tsx` (reader).
- `lib/sections.ts` — single source of truth for the top-level sections that appear in `Masthead` + `Contents`. Derives the Tracking group from `TRACKER_CONFIGS` so adding a tracker updates every nav surface automatically — **currently an empty list, because `TRACKERS_ENABLED` is `false`** (see "Tracker data"). `getCurrentSection(pathname)` picks the active section for the masthead switcher.
- `lib/groupByDate.ts` — buckets items into Today / Yesterday / This week / Earlier (preserves input order within buckets, so the caller's sort wins).
- `lib/useKeyboard.ts` — keyboard shortcut hook with single-key + chord (`g h`) support. Ignores typing in inputs and any modifier-key combo (preserving cmd/ctrl shortcuts).
- `components/Masthead.tsx` — sticky top header: `hub` wordmark on the left, centered section switcher (opens `Contents`), gear `AppMenu` on the right. Also hosts the global `⌘K` / `Ctrl+K` binding that opens `Contents`. Replaces the old `HeaderNav` + `BottomNav` duo (and the later `SubBar` feed-tab row — Saved/Read are plain sections now).
- `components/Contents.tsx` — fullscreen section-jump overlay invoked from `Masthead` or `⌘K`. Groups sections into Reading / Tracking / Library (from `lib/sections.ts`), supports filter-as-you-type + Enter-to-jump, body-scroll lock while open, and renders a chord legend at the bottom (`g h/s/r`, `?`, `⌘K`, `Esc`). This is how section navigation works on both mobile and desktop now — there is no separate bottom tab bar.
- `components/ThemeProvider.tsx` — React context wrapping the Auto/Light/Dark theme (`data-theme` attribute + `hub-theme` localStorage key). Also keeps `<meta name="theme-color">` in sync so the iOS browser chrome matches. A tiny inline script in `app/layout.tsx` applies the saved theme before first paint to avoid a flash.
- `components/FeedCard.tsx` — renders all item types in three magazine variants (article, bluesky post, podcast). Bluesky cards are rendered by the `BlueskyBody` subcomponent with helpers `ReplyContext`, `ImageGrid` (1/2/3/4+ layouts respecting aspect ratios), `ExternalCard`, `QuotedPost`, plus the action chips (like / repost / follow) wired to the `onBskyLike|Repost|Follow` props with optimistic flips and server-driven reverts. The `forwardRef` points to the **swipe wrapper div**, not the inner article — see "Touch UX" below. Podcasts tap to Apple Podcasts via `apple_id`. Long-press on touch fires `onClearAbove` after `LONG_PRESS_MS` (1s).
- `components/FeedClient.tsx` — main feed page-level state, keyboard shortcuts, refresh, dismiss/save/undo/swipe flow, pull-to-refresh, progressive chunked rendering, per-category cache, silent PWA-resume refresh + `Load now` toast, Clear Above, Bluesky write actions, and the Dismiss-visible footer button. URL's `?category=` is the source of truth for the active tab (deep-linkable, survives PWA cold-start).
- `components/SavedClient.tsx` / `components/ReadClient.tsx` — analogous clients for `/saved` and `/read`. ReadClient has no dismiss action (history is read-only) and FeedCard hides the dismiss button when `onDismiss` is omitted. SavedClient passes `disableSwipeSave` so the right-swipe doesn't secretly unsave.
- `components/TrackerClient.tsx` — tracker grid state, status-tab filtering, optimistic updates, keyboard navigation.
- `components/TrackerCard.tsx` — individual tracker item card with cover image, title/subtitle, release date, and inline edit controls (status, rating, ranking). Tapping the card navigates to the item detail page (NOT the external link — that moved to the detail page's CTA).
- `components/TrackerItemClient.tsx` — detail page for a single tracker item. Cover, title, subtitle, release date, external CTA (Apple Music / IMDb / etc.), inline status/rating/ranking controls, and any schema properties not already surfaced (genre, synopsis, runtime, etc.).
- `components/ComicsClient.tsx` — per-storyline issue checklist. Tapping an issue hands off to the Marvel Unlimited iOS app via `marvel.smart.link` (see the comics section below for why this specific URL form is load-bearing). Calls `/api/comics/[id]/read` + `/unread` to toggle local read state.
- `lib/tracker-detail.ts` — helpers for the detail page: `getExternalLinkLabel` picks a friendly CTA label based on domain; `buildExtraProps` filters the Craft schema to the properties worth rendering (skips ones already shown as primary UI, hides empty values and `false` booleans).
- `components/Toast.tsx` — undo / status toast with countdown progress bar; bottom anchor respects iOS `env(safe-area-inset-bottom)`.
- `components/KeyboardHelp.tsx` — `?` overlay listing shortcuts. **Source of truth for the user-facing keyboard list.**
- `components/AppMenu.tsx` — gear icon dropdown with theme toggle (Auto/Light/Dark), push-notifications toggle (`Enable release alerts` / `Release alerts on` / `Blocked in system settings` — **hidden while `TRACKERS_ENABLED` is `false`**, since tracker releases are the only push sender), commit + last-merge version info baked in by `next.config.mjs`, and the Log out button (posts to `/api/auth/logout`).
- `components/ServiceWorkerRegister.tsx` — registers the Serwist-generated SW on the client.

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

### Touch UX — pull to refresh
First-class gesture in `FeedClient.tsx`. An indicator zone above the category nav grows with the damped finger travel (`PULL_DAMPING`), showing "↓ Pull to refresh"; at `PULL_ARM_HEIGHT` the arrow flips, the label becomes "Release to refresh", and `navigator.vibrate` ticks where supported (no-op on iOS — the visual flip carries it there). Releasing while armed holds the zone at `PULL_HOLD_HEIGHT` with a spinning ⁂ until the crawl settles, then collapses it. Implementation notes:
- Height/opacity are written **directly to the DOM** during the drag; React state only tracks the discrete phase (`idle/pull/armed/refreshing`) for the label. A setState per touchmove would re-render the whole card list at 60Hz.
- The gesture only starts at `window.scrollY === 0`, yields to horizontal card swipes before engaging, and aborts if the finger reverses.
- `overscroll-behavior-y: contain` on `<body>` (globals.css) keeps the native iOS rubber-band from doubling the motion — the zone is the only thing that moves.
- Tunables (`PULL_DAMPING`, `PULL_ARM_HEIGHT`, `PULL_MAX_HEIGHT`, `PULL_HOLD_HEIGHT`) live at the top of `FeedClient.tsx`.

### Navigation
Section navigation went through a rewrite: the old `HeaderNav` + `BottomNav` split was replaced by a single pattern that works the same on mobile and desktop.

- **Masthead** (`components/Masthead.tsx`) is the sticky top header: wordmark on the left, centered section switcher button, gear `AppMenu` on the right. The switcher shows the current section's name and opens `Contents`. Masthead also owns the `⌘K` / `Ctrl+K` global binding. It is the ONLY persistent chrome — there is no sub-tab bar below it.
- **Contents** (`components/Contents.tsx`) is the fullscreen section picker. Sections come from `lib/sections.ts`, grouped into **Reading** (Feed, Saved, Read — each a full section, so the masthead switcher correctly reads "Saved"/"Read" on those routes), **Tracking** (one entry per tracker in `TRACKER_CONFIGS` — **currently renders nothing; the group is hidden**, see "Tracker data"), **Library** (Comics, Hoops). Type to filter; Enter jumps to the first match; Esc closes. Adding a tracker to `TRACKER_CONFIGS` automatically adds it to both the Masthead switcher and Contents — there's no separate nav config to update.
- **Saved / Read reachability**: via Contents (switcher tap or `⌘K`), the `g s` / `g r` keyboard chords, and each page's own `<h1>`. They're archive views — occasional visits don't earn always-visible tabs. The old `SubBar` (Today/Saved/Read row under the masthead) was removed for this reason.
- The Feed's **category row** (`FeedClient.tsx` controls row) is in-page and scrolls away with the content — deliberately not sticky; category switching happens at the top of a session, not mid-scroll. On mobile it's a single horizontally scrollable line (hidden scrollbar), not a wrapping block.

### Visual identity
- Fonts loaded via `next/font/google` in `app/layout.tsx`: **Newsreader** (display + body, variable serif) and **JetBrains Mono** (kickers, badges, timestamps). Both exposed as CSS vars `--font-display` / `--font-mono` and aliased in `tailwind.config.ts` as `font-display` / `font-mono`.
- Theme tokens live in `tailwind.config.ts` (`ink`, `cream`, `rule`, `accent`, per-category `cat.*` for podcasts/music/books/film/tech_review/reading/bluesky/games/tv/hoops/practice). Don't hardcode hexes in components — extend the theme. The actual color values come from CSS variables in `app/globals.css`, scoped by `[data-theme="light"]` / `[data-theme="dark"]` / `@media (prefers-color-scheme)` so the Auto/Light/Dark switch in `AppMenu` really does retheme everything in one attribute flip.

### API routes
Items
- `GET  /api/items?category=&limit=&offset=` — lists unread items. The All view uses `getMainFeedItems` (see Feed filtering invariants): every unread RSS item + proportional bluesky. Categories use pure recency. `limit` is capped at 2000 server-side. Response includes `counts: CategoryCounts` for the tab labels.
- `POST /api/items/[id]/read` — marks read (upserts `item_state.read_at`). Used by per-item dismiss flows.
- `POST /api/items/[id]/open` — marks BOTH `read_at` AND `consumed_at`. Used by open flows. **Distinct from /read** so the /read history view can distinguish "I clicked this" from "I dismissed this".
- `POST /api/items/[id]/unread` — clears `read_at` (used by undo).
- `POST /api/items/[id]/save` — toggles saved. **When toggling on, also sets `read_at`** so the item leaves the main feed.
- `POST /api/items/[id]/bsky-like` — toggle the viewer's like on a Bluesky post. Creates or deletes a `like` record via AT Protocol, updates `metadata.viewer.like_uri` + `like_count`, returns the new state so the client can reconcile.
- `POST /api/items/[id]/bsky-repost` — same shape for reposts. Updates `metadata.viewer.repost_uri` + `repost_count`.
- `POST /api/items/[id]/bsky-follow` — one-way follow of the post's author. We deliberately never unfollow from here. On success, propagates `metadata.viewer.following_uri` to every other Bluesky item authored by the same DID so their Follow chips hide too.
- `POST /api/items/read-bulk` — body `{ ids: string[], unread?: boolean }`. Bulk mark-read or bulk-clear-read in a single transaction. Backs per-item dismiss's undo, Clear Above, the visible-items "Dismiss all" footer button, and all mark-all undos.
- `POST /api/items/read-all` — body `{ category?: string }`. Bulk dismiss every unread item in scope (omit category for "everything"). Returns the affected IDs so the client can build an undo. **Sets only `read_at`, never `consumed_at`** — see the bulk-dismiss invariant above. The current UI prefers `read-bulk` for the footer button (to only dismiss what the user actually saw); this endpoint remains for any "wipe everything" flows.
- `POST /api/refresh` — forces an immediate `fetchAllSources()` run.

Trackers — **all 404 while `TRACKERS_ENABLED` is `false`** (see "Tracker data")
- `GET  /api/trackers/[slug]` — returns `{ items: TrackerItem[] }` by fetching the Craft collection and normalizing via `lib/craft.ts`.
- `PUT  /api/trackers/[slug]/[itemId]` — body may include `status`, `rating`, or `ranking`; forwards to Craft via `updateCollectionItem`. Handles the music collection's trailing-space `now listening ` quirk via `untrimStatus`.

Comics
- `POST /api/comics/[id]/read` — mark a Marvel Unlimited issue as read (`comic_state` row).
- `POST /api/comics/[id]/unread` — delete the row.

Hoops
- `GET /api/hoops/teams?mode=results|roster|blend` — 30 teams ranked by net rating (`off - def`), each with roster size and the |results − roster| disagreement, plus the league disagreement summary and the bundle's provenance (`PARAM_VERSION`, data-as-of, row counts). An unknown `mode` falls back to `blend`. Triggers the lazy import on first call.
- `POST /api/hoops/sim` — body `{ home, away, neutral?, mode?, nSims?, nonce?, runId? }`. Runs the possession engine and returns `{ summary, box, meta, elapsedMs }`: win probability, the home spread (market convention — a favourite is negative), total, margin/total quantiles, a margin histogram, **and the expected box score off the SAME replicates** (one simulation, not two — otherwise the histogram and the box score would describe different sets of games). `nonce` is what makes two taps different games; omit it and the same body replays the same games. ~370ms for 1,000 replicates.
- `POST /api/hoops/boxscore` — body `{ home, away, mode, ratingMode?, neutral?, runId?, nSims? }`. `mode: "expected"` is the mean line over replicates; `mode: "sample"` is ONE specific night with integer lines. In sample mode a `runId` alone is sufficient and **wins over any teams in the body** — the id is self-describing, so honouring a mismatched pair would silently return a game the id doesn't name.

Push
- `GET    /api/push/subscribe` — returns `{ subscribed: boolean }`.
- `POST   /api/push/subscribe` — saves a Web Push subscription (body is the subscription JSON).
- `DELETE /api/push/subscribe` — removes the stored subscription.
- `POST   /api/push/test` — sends a test push notification (returns `{ sent: boolean }`).

Auth
- `POST /api/auth/login` — reads `password=` form field, sets the `hub-auth` cookie to `deriveAuthToken(password)`, returns a **303** redirect to `/`. 303 (not 307) is load-bearing — iOS Safari preserves the POST method on a 307 and re-POSTs to `/`, which fails with "Safari can't open the page because the address is invalid".
- `POST /api/auth/logout` — clears the cookie, 303 redirects to `/login`.

### Keyboard shortcuts
Defined in `components/FeedClient.tsx` (and subsets in `SavedClient.tsx` / `ReadClient.tsx`). Source of truth for the user-facing list is `components/KeyboardHelp.tsx`. Keys: `j`/`k` nav, `o`/`enter` open, `s` save, `x`/`e` dismiss, `c` clear-above (dismiss this card + everything above it), `r` refresh, `g h` / `g s` / `g r` go home/saved/read, `?` toggle help, `esc` closes help. The `Masthead` also binds global `⌘K` / `Ctrl+K` to open the `Contents` section-jump overlay.

### Source types in config
- `type: rss` / `type: podcast` — both use the RSS fetcher; podcasts additionally parse `itunes:*` fields and store `apple_id`, `duration`, `artwork_url` in the `metadata` JSON column. RSS categories in use: `reading`, `tech_review`, `books`, `music`, `film`, `podcasts`. `tech_review` exists specifically to give Verge reviews a review-tier priority while generic Verge articles stay in `reading`.
- `type: bluesky` with `mode: feed` + `feed_uri` — fetches a specific Bluesky algorithmic feed (e.g. "Popular With Friends").
- `mode: account` + `handle` — individual Bluesky accounts. Currently uses `posts_no_replies` filter so reply context never appears for these sources.
- `mode: timeline` — the authenticated user's home timeline.

### Config architecture (Tune)
The live config is ONE YAML document. Where it lives: the SQLite `kv` table (key `config_yaml`) once anything has been saved from the Tune UI; until then, the repo's `config/feeds.yml`. `getConfig()` in `lib/config.ts` prefers the DB copy and falls back to the repo file (and falls back again if the DB copy fails validation — a corrupt save can't brick the app). `resetConfigToRepo()` deletes the kv key ("Restore repo config" in the YAML pane). The repo file is a **seed and backup**, not a co-equal source of truth: the YAML pane shows a "differs from repo feeds.yml" line with a Copy button, and folding changes back into the repo is a manual paste + commit on the user's schedule. The config is re-read every poll cycle (`invalidateConfig()`), so changes take effect without restart; source add/remove syncs the DB automatically on the next cycle.

The `algorithm:` block in the same document holds every All-view knob (per-category `priority` — 0 removes a category from the All view entirely, `bsky_ratio`, `bsky_window`, `surprise`, `jitter`, `ttl_days` as a number or per-category map, `retention_days`). Defaults live in `ALGORITHM_DEFAULTS` in `lib/config.ts` and match the values that used to be hardcoded in `lib/queries.ts` — an absent block means unchanged behavior. `getAlgorithm()` resolves block-over-defaults; `getMainFeedItems`/`getCategoryCounts` accept an overrides param so `/api/tune/preview` can dry-run draft knobs without persisting.

Per-source config: `poll_interval_minutes` (minimum minutes between fetches — honored by the crawl since Tune shipped; unset = every crawl; failed sources retry every cycle) and `paused: true` (crawl skips the source, items are kept — unlike deleting the source, which prunes its items). Fetch failures are recorded on `sources.last_error` (cleared on success) for the Tune roster's health dot.

**The Tune section** (`/tune`, gear menu → "Tune sources & algorithm", `g t` chord): three panes in `components/TuneClient.tsx`. **Sources** — roster grouped by category with health dot / items-per-week / unread / last-fetch (from `GET /api/tune/sources`), per-source interval select, pause toggle, delete (confirm dialog warns about pruning), and a paste-first add flow (`POST /api/tune/detect` accepts a feed URL, site URL — probes `<link rel="alternate">`, `@handle` or `at://` URI for Bluesky, or an Apple Podcasts link — resolved via the iTunes lookup API, which also fills `apple_id`) that previews the 3 newest items before committing. **Algorithm** — priority steppers + sliders for the knobs, with a live preview strip (debounced `POST /api/tune/preview`, one colored tick per card in simulated All-view order, re-roll button to see the jitter/surprise variance). **YAML** — the raw document in a textarea, validated on save (`PUT /api/tune/config` with `{yaml}`; the other panes PUT `{config}` and the server serializes), plus restore-from-repo and copy-as-backup. Structured edits and YAML edits go through the same validated write path.

### Item metadata (the JSON blob)
The `metadata` column is a JSON blob. Schema varies by type:

- **Podcast**: `{ show_name, duration, audio_url, artwork_url, apple_id }`
- **Bluesky**: `BlueskyMetadata` from `lib/types.ts`. Always has `handle`, `avatar_url`, `like_count`, `reply_count`, `repost_count`. Optionally has `display_name`, `images[]` (with `thumb`/`fullsize`/`alt`/`aspect_ratio`), `video{}` (native Bluesky video from `app.bsky.embed.video#view`: HLS `playlist` URL + `thumbnail`/`alt`/`aspect_ratio` — rendered as a tap-to-play `<video>` where native HLS is supported, i.e. Safari/iOS; elsewhere the tap falls through to opening the post), `external{}` (link card with `url`/`title`/`description`/`thumb`/`domain` — external cards pointing at a YouTube video render as a tap-to-load `youtube-nocookie.com` iframe embed instead of the link card, detected client-side by `youtubeVideoId` in `FeedCard.tsx`, so no fetcher/schema change was needed), `quoted{}` (a nested post that may itself have images, a video, and an external link — its video renders as a static poster since the quoted card is a link), `reply_to{}` (parent author + truncated text), `reposted_by{}` (the reposter when the post appears via a repost). The Bluesky fetcher also writes post identity (`uri`, `cid`, `did`) and a `viewer` block (`like_uri`, `repost_uri`, `following_uri`) — the AT Protocol URIs of the viewer's own like/repost/follow records when present, used both to render "already done" state and as the target for delete calls. The fetcher extracts everything from the `app.bsky.embed.*` and `feedViewPost.reply`/`reason` fields; the Bluesky write endpoints mutate the viewer block in place when the user interacts. Older rows that aged out of the source feed before a given field was added still have the old shape — the renderer treats all rich fields as optional, and the write endpoints surface a 409 "Post identity not available yet" when `uri`/`cid`/`did` are missing (next poll repopulates them).

### Tracker data (Craft.do collections) — 🔴 HIDDEN, not deleted

🔴 **The whole Tracking section is switched off behind `TRACKERS_ENABLED` in `lib/tracker-config.ts` (currently `false`) — Stow (`~/Code/stow`) replaced it.** Everything below still describes code that is present and intact; none of it is reachable. Flip the flag to `true` and the entire section returns — there is no second switch. What the flag gates, in the five places that read it:
- `lib/sections.ts` — the Tracking sections aren't built, so the group vanishes from the Masthead switcher and Contents (Contents drops empty groups on its own) and the remaining sections renumber. Verified in the built client bundle, not just by reading: `trackers/books` appears zero times in `.next/static/chunks` with the flag off.
- `middleware.ts` — `/trackers/*` and `/api/trackers/*` are refused before the auth check (it's a routing rule, not an auth rule, so a logged-out request 404s rather than being sent to `/login` for a section that's gone). 🔴 **The page 404 is done by rewriting to an unmatched path** (`/section-not-found`), NOT by `NextResponse.rewrite(…, { status: 404 })` — a rewrite takes its status from the rewritten route, so that form renders the not-found body under HTTP **200**. Measured both ways; the check below is what caught it.
- `getTrackerConfig` (same file as the flag) returns `undefined` for every slug, so even if the middleware rule were removed the routes still refuse: `/trackers/[slug]` and `/trackers/[slug]/[itemId]` `notFound()` on an unknown slug and both `/api/trackers/*` routes 404. 🔴 That in-route path alone is **not** sufficient, which is why the middleware rule exists: those pages' `generateMetadata` is `async`, and Next 14 commits the response status before the component throws — so `notFound()` there renders the right body under a 200.
- `lib/release-notify.ts` — `checkReleaseNotifications` returns immediately, so the poll cycle stops scanning Craft daily and can't push a notification whose deep link now 404s.
- `components/AppMenu.tsx` — the "Release alerts" toggle and its subscription probe are hidden, because tracker release dates are the only thing that has ever pushed. The push plumbing itself (`app/sw.ts`, `lib/push.ts`, `/api/push/*`) is untouched and still works.

Deliberately NOT done, so the flag stays a clean revert: `CRAFT_API_KEY` is still read by `lib/craft.ts` and still listed as required, the Craft client and all four Tracker components remain, and nothing was renamed.

**The gate: `npm run check:tracking-hidden`** (`scripts/check-tracking-hidden.mjs`, `FEED_BASE` defaults to `http://localhost:3000`; pass `--password` or set `FEED_PASSWORD` for production). Two halves. **Static**: every module that imports `TRACKER_CONFIGS` must also read `TRACKERS_ENABLED` — the landmine pin, because the easy way to accidentally un-hide the section is a NEW consumer that iterates the configs without checking. **Live**: asks a running instance for all 15 tracker URLs and requires a real 404 from each, having first asserted `/` is 200 so a dead server can't make the 404s pass for the wrong reason. Falsified at merge by flipping the flag back to `true`, rebuilding, and confirming exit 1 with 16 failures. It is deliberately **not** in `prebuild` — half B needs a server, and a check that skips its own assertions when one isn't there is worse than no check.

Trackers are backed by Craft.do collections fetched via the Craft Connect API (`lib/craft.ts`). Each tracker is configured in `lib/tracker-config.ts` with a `collectionId`, display options, and field mappings. `normalizeItems` in `lib/craft.ts` maps raw Craft items into `TrackerItem` objects (`lib/craft-types.ts`).

**Release dates**: `normalizeItems` extracts `releaseDate` from Craft properties. Music, movies, TV, and games all have a `release_date` (date type) property. Books uses `publication_year` (number type) instead — displayed as just the year. `TrackerCard` formats dates as "Mon DD, YYYY" for full dates.

The Craft schema for each collection also includes extra fields not currently surfaced in the UI (e.g. `genre`, `synopsis`, `runtime_minutes`, `in_plex` for movies; `number_of_songs`, `genre` for music; `length_in_pages` for books; `season` for TV). These live in `item.properties` and can be accessed if needed.

### Push notifications (release date alerts) — dormant while Tracking is hidden

Nothing pushes right now: release alerts were the only sender, and both the toggle and the daily checker are behind `TRACKERS_ENABLED` (see above). `POST /api/push/test` still sends to an existing subscription. The rest of this section describes the flow as it works with the flag on.

Web Push via VAPID, powered by the `web-push` npm package. Single-user, so the subscription is stored in the SQLite `kv` table (key `push_subscription`).

**Flow:**
1. User taps "Enable release alerts" in AppMenu (gear icon). iOS prompts for notification permission (user gesture required). The browser creates a push subscription and POSTs it to `/api/push/subscribe`.
2. Every poll cycle (~15 min), `fetchAllSources` calls `checkReleaseNotifications()` from `lib/release-notify.ts`. A date guard (keyed `release_notify_last` in the `kv` table) ensures it only runs once per calendar day in `NOTIFY_TIMEZONE` (America/Denver), and the run is deferred until the local hour is at or past `NOTIFY_HOUR` (8 AM) — otherwise server-time UTC would fire at Mountain-time midnight.
3. The checker fetches all 5 Craft tracker collections, compares each item's `release_date` against today (YYYY-MM-DD in the local tz), and sends **one push per releasing item** deep-linking to that item's detail page (`/trackers/{slug}/{itemId}`).
4. The service worker (`app/sw.ts`) handles `push` events (shows the notification) and `notificationclick` events. The click handler reuses an existing window if the PWA is open, but always calls `client.navigate(url)` first so the tap lands on the notification's destination — not wherever the user had left the app.

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

### Books — the EPUB library + OPDS + KOReader sync server
Serves the Xteink X3 (CrossPoint firmware) and Readest on iOS: an OPDS 1.2 catalog, the vanilla
KOReader-sync (kosync) protocol, an upload/manage UI at `/books`, and reading statistics at
`/books/stats` derived from the sync log. Replaced the Stump server
that ran on the Mac Mini (torn down per `BOOKS_PLAN.md` §11; requirements source was
`~/Code/stump/MAC-MINI-DEPLOYMENT-PLAN.md`). Files live at `data/books/<id>/book.epub` on the
Railway volume; `/Volumes/HDD/Books` on the Mini remains the master copy/backup.

🔴 **The invariant everything rests on: byte identity** (`BOOKS_PLAN.md` §4). The kosync document
key is a partial MD5 of the FILE BYTES (`lib/books/partialMd5.ts` — offsets `1024 << 2i`,
i = −1..10, 1024 bytes each), computed independently by every device. Consequences: the stored
epub is IMMUTABLE (metadata edits touch only the DB row; a changed file is a NEW book id), the
download routes serve bytes untouched (no compression/rewrite middleware may ever wrap them), and
a *different copy* of the same title (re-rip, Calibre re-export) silently never syncs. Breakage
here has NO error surface — both devices keep reporting success against different keys.
`check:books:bytes` pins it: our hash vs an offline Python reference digest
(`books-fixture/expected.json`), verified 13/13 against Stump's Rust hashes at build-out.

🔴 **Auth: key-in-URL** (`/opds/{key}/v1.2/…`, `/kosync/{key}/…`), the shape proven against
CrossPoint by the Stump deployment — e-readers store one URL and cannot complete a challenge.
`BOOKS_API_KEY` env var, timing-safe compare, exempted from `middleware.ts` alongside
`api/hoops/import`, and like it **fails CLOSED when unset** (do not "fix" to match middleware's
fail-open). kosync user auth on top: `x-auth-user` + `x-auth-key` headers where the key is
**md5(password) computed client-side** — the wire value is fixed by the KOReader protocol and must
never be "hardened"; only the at-rest storage is (sha256 of the wire key, `kosync_users.key_hash`).

🔴 **`kosync_progress.progress` is OPAQUE** — an EPUB x-pointer from CrossPoint/KOReader (richer
with char offset from Readest), stored and returned byte-exact, never parsed or normalized. This
opacity is precisely what Stump got wrong from the other side (its own app wrote Readium locators
and clobbered x-pointers — `~/Stump/stump-issue-draft.md`). `kosync_progress.document` is
deliberately NOT an FK to `books` — devices may sync sideloaded files; the UI joins to books on
`books.partial_md5` when they match. Single-user registration: `users/create` is open only while
`kosync_users` is empty. **One deliberate exception to opacity — catch-up positioning, below —
SYNTHESIZES new pointers; it never parses or rewrites a device-written one.**

**Catch-up positioning ("Catch up from the audiobook", `/books/[id]`).** Listening happens on
Audible; when it's time to hand back to the X3/Readest, you type or dictate a phrase you just
heard, the hub finds it in the epub, and one confirmed tap writes the position — the device jumps
forward on its next sync. Built AFTER measuring the alternative: mapping Audible's
`position_ms`/`percent_complete` through runtime is ±4 pages at best (measured on real
chapter-aligned books), needs Amazon device credentials on Railway, and chapter matching dies on
epubs with no usable chapter structure (4 of the first 6 real books). A phrase is exact and needs
no credentials.
- 🔴 `lib/books/xpointer.ts` is the ONE place a `progress` value is ever CONSTRUCTED. The dialect
  (`/body/DocFragment[N]/body/…/p[K]`; DocFragment 1-based over the FULL spine; element steps
  indexed 1-based among same-TAG siblings) was validated **byte-exact against all three
  paragraph-level pointers real devices had synced to production** before anything shipped.
  Readest's richer `text()[i].offset` form is deliberately never synthesized — paragraph
  resolution is what a heard phrase justifies.
- 🔴 **The search is built for DICTATION, not copy-paste** — the phrase arrives by ear, with no
  punctuation, approximate spelling, dropped words. Word-level fitting alignment (whole query,
  free start/end in the book, gaps cost rather than disqualify) with lyric-follow's fuzzy tiers
  (exact / shared-prefix ≥4 / one edit for ≥5 chars) plus diacritic folding (heard "smeagol",
  printed "Sméagol"). Substring matching is the wrong tool; it was the first implementation and
  was replaced.
- Routes: `POST /api/books/[id]/find-position` `{phrase}` → candidates with snippet/percentage/
  confidence (read-only); `POST /api/books/[id]/set-position` `{pointer, percentage}` → writes via
  **`putProgress`, the same single write path device syncs use**, so `reading_events` records the
  movement (device `"hub"`) and the stats try/catch protects this write too. 🔴 set-position
  refuses anything `isSynthesizedPointer` doesn't recognise — it must never become a general
  "write any progress string" endpoint, and specifically refuses the device's own `text()` form.
  409 when no kosync user is registered yet (never invents the account).
- **The gate: `npm run check:books:xpointer`** (in `prebuild`). Dialect pinned against an
  independent Python implementation (`scripts/gen_book_xpointer_reference.py`, html.parser —
  itself the implementation validated against the real device pointers; 26 sampled pointers in
  `books-fixture/expected.json` under `xpointer`, byte-compared). The committed fixture is flat
  (900 `<p>` directly under body, all identical text), so the check also builds a nested epub
  in-memory for section/div indexing and the dictation-damage behaviour: a half-misheard phrase
  must resolve to the same paragraph as the exact quote, and gibberish must return nothing.
  Falsification-tested: wrong sibling indexing, 0-based DocFragment, and fuzzy tiers removed all
  fail (the last one needed the half-misheard assertion — the milder damaged phrase passed on
  exact words alone, which is exactly the kind of vacuous check the falsification run exists to
  catch).

**CrossPoint parser constraints** (each a silent failure; asserted by `check:books:opds`, whose
assertions are ported from `~/Stump/healthcheck.sh` and anchored on a committed snapshot of
Stump's device-proven feed, `books-fixture/stump-books-feed.xml`): ≤62 entries/feed page
(`PAGE_SIZE=50`), acquisition type EXACTLY `application/epub+zip` (strcmp), rel containing
`opds-spec.org/acquisition`, href containing `.epub`, pagination rel `previous` never `prev`.

**The "To Read" shelf** (`books.to_read` / `to_read_at`, additive migration). A per-book star in
the hub — on each grid cover and on the detail page — that puts the book in its own OPDS feed at
`{base}/to-read`, listed **first** in the catalog root with a live count in its summary.
🔴 **It exists for the DEVICE, not the hub: the X3 has no search**, so reaching a specific book
means scrolling the whole catalog, which stops being viable as the library grows. A shortcut buried
below the other entries would be a shortcut to nothing, hence the ordering. The shelf is ordered
**newest decision first** (`to_read_at DESC`) and deliberately *not* run through `sortForCatalog` —
re-sorting it by author is exactly what the shelf exists to avoid. Clearing the flag nulls
`to_read_at`, so re-adding puts a book back on top. An empty shelf still returns a valid empty
acquisition feed, never a 404, because the catalog entry is always advertised and must always open.
Toggled via `POST /api/books/[id]/to-read` `{toRead}` — its own endpoint rather than a field on
`PUT /api/books/[id]`, so `BookEdit` (the shape `check:books:metadata` reasons about) is unchanged.
🔴 `setToRead` is a **second write path into the `books` table**, and `check:books:metadata` says
nothing about it — so `check:books:opds` asserts there too that flagging leaves the file, its
sha256 and its `partial_md5` untouched. Flagging the book you're reading must be free.

**Metadata comes from the epub, never from the folder.** 🔴 Author/series are read from the
file's OWN internal OPF at ingest — `/Volumes/HDD/Books`'s `Author/Series/NN - Title.epub` layout
is for human browsing only, and the hub never sees it (the upload endpoint receives a bare
filename). Consequence: a book whose OPF lacks series data gets none however its folder is named,
and the fix is to edit it in the `/books` UI, which exposes every field. 🔴 That is safe to do
freely — and `check:books:metadata` is the gate that keeps it so: a metadata edit writes database
columns only and can never change the file, its sha256, or its `partial_md5`, so editing a book
you're currently reading cannot lose your place. (Falsification-tested by making `updateBook`
touch the file.) `SERIES_OVERRIDES` in `normalize.ts` handles the case where a re-ingested file
should get its series back automatically; one-off corrections belong in the UI, not in that table.

**DRM: every upload is brought into the clear before it is ingested, or it is refused.** The
upload route runs `prepareForIngest` (`lib/books/prepare.ts`) on the raw bytes FIRST; nothing
downstream — `ingestBook`, OPDS, kosync, stats — ever sees an encrypted file. This is the seam
that will make an `.acsm` upload identical to an `.epub` upload from the user's side: the route
does not branch on file type beyond the accept filter, and the `.acsm` fulfilment step (not yet
built — step 2) slots in as a single call inside `prepareForIngest`, which then recurses through
the same decrypt path. 🔴 **It exists first as a guard against a silent failure with no error
surface**: measured on a real Adobe-DRM (ADEPT) epub, the old ingest path accepted it happily and
produced a "34-page" edition of a 400-page book — 13k words against a true 155k, a cover that was
139 KB of ciphertext stored as `cover.jpg`, and a catch-up phrase search that found nothing, with
every layer reporting success. Refusing is strictly better than ingesting broken, so a file that
can't be brought into the clear never reaches `ingestBook`.
- 🔴 **A DRM-free epub passes through BYTE-IDENTICAL** — no repack, no re-hash, so `partial_md5`
  is untouched (BOOKS_PLAN §4). Only an ADEPT file is rebuilt, and font-obfuscated epubs (which
  reuse `encryption.xml` with a different algorithm and carry no `rights.xml`) are *not* DRM and
  pass through untouched too.
- `lib/books/adept.ts` — detect (`inspectEncryption`) + strip (`decryptAdept`). ADEPT = content
  entries AES-128-CBC encrypted (deflated first, IV = first 16 bytes), the AES key RSA/PKCS#1-v1.5
  wrapped in `rights.xml` with the account key. 🔴 The decrypt logic is a faithful port of DeDRM's
  `ineptepub.py`, **corrected against a real Google Play Books fulfilment** (see the validation note
  below) — three things the port got from reality that a synthetic fixture would not have: (1) real
  Adobe `encryption.xml` carries **no `<Compression>` element** (an earlier version invented one);
  compression is implicit, so every entry is try-inflate-then-fall-back-to-raw. (2) The content key
  is **PKCS#1 unwrap then take the LAST 16 bytes** (`bookkey[-16:]`), not "exactly 16" — real keys
  can unwrap to a longer payload. (3) A separate `aes128-cbc-uncompressed` algorithm marks
  already-compressed payloads (video) that must NOT be inflated. 🔴 Unlike `epubMeta.ts`/
  `epubText.ts`, failure here is NOT benign — a half-decrypt would ingest as readable-looking
  garbage — so every failure throws `AdeptError` and the upload refuses. 🔴 **Wrong-key defence is
  inflate-based, and this is load-bearing**: Node's `privateDecrypt` does not reliably throw on a
  wrong key, and the naive "decrypted markup contains a `<`" backstop is far too weak (random bytes
  carry a `<` within 1 KB ~98% of the time — and a real CSS file legitimately has none, which
  false-*rejected* a perfect decryption). The strong signal is that a content document's AES
  plaintext is a valid DEFLATE stream (noise never is); the decryption is CONFIRMED only when at
  least one XHTML/OPF/NCX/SVG entry both inflates and reads as markup, and is refused otherwise. The
  deliberate cost: an all-STORED epub (which real producers never emit — content XHTML is always
  deflated) is refused even with the right key. Safe failure over shipping unverified bytes.
- `lib/books/zip.ts` — a minimal deterministic ZIP writer, because `adm-zip` (the reader) **cannot
  emit a conforming EPUB**: measured, it sorts entries alphabetically (so `mimetype` stops being
  first) and ignores a per-entry STORED override. `writeEpub` forces `mimetype` first + STORED and
  uses fixed 1980 timestamps, so a re-decrypt is byte-identical and can never mint a new
  `partial_md5` for an already-synced book.
- `lib/books/adeptKey.ts` — `ADOBE_ADEPT_KEY` env var (PKCS#8 DER, base64). Fail-CLOSED when
  unset, same convention as `BOOKS_API_KEY`/`HOOPS_IMPORT_TOKEN`: no key → DRM'ed uploads refused,
  DRM-free unaffected. 🔴 Becomes mostly vestigial once `.acsm` fulfilment lands (the hub will mint
  its own **anonymous** Adobe activation into the `kv` table — no account, no secret to rotate);
  structured now so the call sites never change.
- **The gate: `npm run check:books:drm`** (in `prebuild`). Builds an ADEPT fixture in-memory from
  `fixture.epub` — shaped like the real Google file (no `<Compression>`, `<ResourceSize>` instead,
  a deflated-XHTML body plus one `aes128-cbc-uncompressed` clip, and a 20-byte wrapped payload so
  last-16 is load-bearing) — and asserts decrypt-or-refuse: right key → word count matches the
  offline Python reference and every spine doc + the cover is byte-identical; the uncompressed clip
  decrypts without inflating; wrong key / no key / AES-256 / `.acsm` / non-zip → refused with a
  typed code and nothing left on the volume; clean + font-obf epubs pass through byte-identical.
  🔴 **What it cannot see, stated in the script header**: the fixture is self-built, so the gate
  proves the decryptor inverts our encryptor and loses nothing — it does NOT prove the on-disk-layout
  reading is right. No real ADEPT file can live in the repo (it would be a DRM'd book). Committed
  throwaway keys (`books-fixture/adept-test-keys.json`, not secrets) because a randomly generated
  "wrong" key made the wrong-key refusal probabilistic. Falsification-tested: **11/11** perturbations
  caught (guard removed, font-obf as DRM, inflate-confirmation removed, weak `<`-only canary,
  first-16 vs last-16, wrong IV, uncompressed force-inflated, AES-256 un-rejected, clock timestamps,
  mimetype not first/STORED, rights.xml retained).
- 🔴 **Real-file validation (the anchor the gate can't be, done once, 2026-08-18).** A real Google
  Play Books purchase was fulfilled to an encrypted epub (anonymous Adobe activation via
  Leseratte10's `acsm-calibre-plugin` standalone scripts, in a scratchpad venv — the `.acsm` token
  lives ~15 min, so fulfil within minutes of download), and `decryptAdept` produced a correct,
  readable book (right title/author, valid JPEG cover, plausible word count). The decisive check:
  its decrypted spine is **byte-for-byte identical** (same SHA-256) to an independent Python +
  pycryptodome reference decryptor over the same file — two implementations, different languages
  and crypto libraries, agreeing on real bytes. That confirms the layout reading; the gate then
  guards against regressions. This is exactly what surfaced the three corrections above.

**Key files:** `lib/books/partialMd5.ts` (the hash — do not touch), `epubMeta.ts` (regex OPF
extraction; failure falls back to filename, never fails ingest), `normalize.ts` (author/series
rules + `SERIES_OVERRIDES`, ported from `~/Stump/organize-books.py`), `store.ts` (CRUD + ingest,
content-addressed dedupe on sha256), `opds.ts` (pure XML emitters), `kosync.ts` (protocol
semantics), `apiKey.ts` (the credential gate); `store.ts` also carries `listToRead`/`setToRead` for
the To Read shelf. DRM path: `prepare.ts` (the upload boundary — `prepareForIngest`, the ONE place
`.acsm`/`.epub` converge and the ghost-book guard lives), `adept.ts` (detect + strip ADEPT),
`zip.ts` (deterministic OCF-conforming writer, since `adm-zip` can't emit one), `adeptKey.ts`
(`ADOBE_ADEPT_KEY`, fail-closed). Routes: `app/opds/[key]/v1.2/[...path]/route.ts`
(catalog/feeds/search/file with Range support/cover), `app/kosync/[key]/[...path]/route.ts` (the
five kosync endpoints), `app/api/books/*` (cookie-gated manage + `kosync-import` for the Stump
migration). UI: `app/books/*`, `components/BooksClient.tsx` (grid + upload + on-screen device
setup incl. the two silently-failing settings: CrossPoint matching=Binary / Readest checksum=File
Content), `components/BookDetailClient.tsx`. Scripts: `push-books.mjs` (bulk upload; idempotent),
`migrate-stump-progress.mjs` (one-time; carries `koreader_progress`+`end_percentage` only, ignores
Readium `end_locator`, never rolls back a newer device position, ends by asserting every migrated
hash resolves to a catalog book). Relative `.ts` imports in `lib/books/` follow the hoops
convention so plain node runs the check scripts against the real modules.

#### Reading statistics (`/books/stats`)

A streak, a year heatmap, finish projections and badges — all derived from the kosync log, none
of it entered by hand. Entry points: the `Stats` link and streak strip on `/books`, a per-book
history block on `/books/[id]`.

🔴 **`kosync_progress` cannot answer a single historical question, which is why `reading_events`
exists.** That table is ONE UPSERTED row per document — every sync destroys the position it
replaces, so "when did I read" is not recoverable from it at any later date. `reading_events` is
an append-only row per sync, written inside `putProgress` from the previous position read *before*
the upsert overwrites it. Consequence worth stating plainly: **history begins the day this
shipped**; nothing earlier can be reconstructed, and the UI dates its own record rather than
implying otherwise.

🔴 **The history write is wrapped in a `try/catch` inside `putProgress`, and that is load-bearing.**
Statistics are decoration; the reading position is the product. A missing table or a locked DB must
cost a number on a page, never a reader's place in a book. `check:books:stats` falsifies it by
DROPping `reading_events` and asserting the PUT still stores and returns the position.

🔴 **Three rules keep the numbers honest, each pinned by the gate** (`lib/books/readingEvents.ts`):
an UNCHANGED position writes nothing (KOReader/CrossPoint re-PUT the same position on a timer while
a book merely sits open — recording it would light up the streak for days nobody read); the FIRST
sync of a document is a `'baseline'` with delta forced to 0 (the device is announcing where it
already is, and crediting it books a migrated library's entire past to one afternoon); and `delta`
is stored SIGNED but never subtracts from a day's pages (going backwards is a re-read, not
un-reading). `computeReadingStats` counts only `kind='read'` events as activity.

🔴 **Day bucketing goes through `Intl` with an explicit `America/Denver`, never `floor(ts/86400)`
and never server-local time.** Railway runs UTC, so a 9pm page turn is already tomorrow there — an
evening reader's streak would show gaps on days they actually read, and DST's 23/25-hour days
drift on top. The gate anchors this on the real 2026 transitions (re-derived from the second-Sunday
/ first-Sunday rule, not hardcoded) and asserts the naive bucketing DISAGREES.

**Pages come from the epub's own text.** `books.word_count` (additive migration; NULL = never
attempted, 0 = attempted and empty so a broken file isn't re-unzipped forever) is filled at ingest
and backfilled lazily by `getReadingStats`. A page is `PAGE_WORDS = 387`, printed on screen next to
the numbers.

🔴 **`PAGE_WORDS` is MEASURED, and 250 is the trap.** 250 words/page is the *manuscript* convention
(a double-spaced typescript page), not a printed one — it put The Two Towers at **621 pages against
a real 352-page edition**, which is how the error surfaced: the page said "403 pages to go" on a
book with 229 left. The real value comes from the only ground truth available: some EPUBs carry
their print edition's own pagination as `epub:type="pagebreak"` anchors plus a nav `page-list`, and
two books in `/Volumes/HDD/Books` have one. Pooled (total words ÷ total real pages, not a mean of
per-book ratios): *The Two Towers* 155,347 w / 352 pp and *Call for the Dead* 47,621 w / 172 pp →
202,968 / 524 = **387**. The derivation and its limit live in `pages.ts`'s header — those two books
disagree by **60%** (277 vs 441 w/p), so any single book lands within roughly ±20% of its printed
edition, and the UI says so rather than implying a count. Re-measure and move the constant if more
page-list books arrive; `check:books:stats` pins the value and asserts it stays within 20% of the
Two Towers ground truth, so it can't drift back to a tidy-looking number. **Deliberately NOT done:**
paging a page-list book exactly while others are estimated — every book is measured the same way so
totals stay comparable.

🔴 **`PAGE_WORDS` lives in `lib/books/pages.ts`, which imports NOTHING** — sourcing it
from `epubText.ts` (the tidy-looking place, next to the counting) drags AdmZip into the client
bundle and shipped **182 kB** of zip library to `/books/stats` with everything still working
perfectly. Only the bundle size ever said so; `check:books:stats` now pins it statically.

🔴 **A sync timestamp records WHEN THE DEVICE PUSHED, not when the reading happened — and on the
X3, pushing is MANUAL.** The owner taps it about once a day, in the evening, when handing off to
Readest on the phone, and the overwhelming majority of reading is on the X3. This single fact is
why several obvious-looking statistics are *deliberately absent rather than merely unbuilt*. Each
was built, found to be measuring the push, and removed:
- **Sittings / session lengths.** Clustering syncs reconstructs the shape of the *pushes*. One push
  a day means every sitting spans zero minutes. There is no duration signal in this data — not a
  weak one, none. (Took `SESSION_GAP_MINUTES`, the `Session` type, `records.longestSession`, the
  `Marathon` badge and the per-book "Sittings" tile with it.)
- **Time of day.** An hour histogram plots when sync was tapped, so it reads "you read most at 8pm"
  regardless of when the reading happened. (Took `byHour`, `localHour`, and the `Night Owl` /
  `Dawn Patrol` badges.)

`check:books:stats` pins their **absence** structurally — no `sessions`/`byHour` on the model, no
`longestSession` on `records`, none of those badge keys, and no clock/session helper in the source
— because each one renders as a confident, plausible number that measures the wrong thing.
Falsification-tested by reintroducing each; all caught. Replacements that *are* derivable from
day-and-progress: `Double Century` (200 pages in a day), `Comeback` (resume a book after 30+ days),
`Series Sweep` (finish two from one series).

**The known distortion is stated on screen, not smoothed away:** a day's progress lands on the day
it was *pushed*, so reading spread over two days can arrive as one big day — a quiet Monday beside
a double Tuesday. Spreading a delta backwards across the days it "probably" covers would be
inventing data. Days, positions and pages are measured; nothing else is claimed. Finishing is a
CROSSING of `FINISH_THRESHOLD` (0.97 — readers stop short of 1.0), not a state, so a device idling
at 99% doesn't re-finish a book on every check-in.

🔴 **The forecast rate is GLOBAL — one figure for the reader, divided into each book's remaining
pages — and it must stay that way.** It was per-book first, which sounds more precise and was
useless: a book had to survive `MIN_RATE_DAYS` (3) separate days inside the 21-day window to earn a
forecast, so the feature could only ever fire on the books being read *slowly*. This reader puts a
Discworld away in two days, and those never qualified at all. The evidence belongs to the reader,
so a book opened this morning is forecast on its first sync — and an **unopened** one can be too
(`/books/[id]` on a never-synced book shows what the whole thing costs, since nothing about the
forecast comes from the book beyond its page count). The cost, accepted: a dense book is projected
at the same rate as an easy one. Pages are word-normalised, so prose density partly washes out; how
fast this reader moves through a given author does not, and no arithmetic recovers it from a log
where the fast books never accumulate evidence of their own. Read a per-book number as "if this
book got all of your reading" — with several on the go each is optimistic while their **sum** is
right.

🔴 **Two denominators, deliberately, because the push distortion above hits exactly one of them.**
`perCalendarDay` divides by the FIXED window, so days off count against it and it becomes a real
date ("around Sep 2") — a weekend of reading arriving in one Sunday push moves only the numerator,
so it cannot be skewed by bunching. `perReadingDay` divides by days actually read, answers "how
many more evenings", makes no calendar claim, and *is* exposed to that bunching. The UI shows both
(`approx. 3 days of reading · around Sep 2`) rather than picking one and being wrong about the
other. `check:books:stats` measures the asymmetry directly: the same 600 pages spread over four
pushes vs. bunched into three leaves `perCalendarDay` identical and moves `perReadingDay` 150→200.
Still refuses thin evidence — under `MIN_RATE_DAYS` days in the window there is no rate and no
forecast anywhere, rather than a confident wrong date.

**Key files:** `lib/books/stats.ts` (**pure** — no DB, no fs, `now` always passed in, so the gate
drives it with streams whose answer is known independently; keep it that way; `readingDaysFor` /
`calendarDaysFor` / `finishLabel` are exported so a shelf estimate and a Now Reading estimate share
one implementation), `readingEvents.ts` (the recorder + baseline seeding), `statsData.ts` (the only
impure edge; 🔴 `getBookHistory` runs the model **twice** on purpose — the FORECAST from the whole
log because the rate is global, the TOTALS from this document's events alone because "pages read"
on a book's page means that book. Collapsing it back to the one filtered run it used to be silently
restores per-book rates on the detail page; the gate pins both halves), `epubText.ts` (spine-walking
word count), `pages.ts` (the page convention, dependency-free). UI: `app/books/stats/page.tsx`,
`components/BooksStatsClient.tsx`. Reference generator: `scripts/gen_book_wordcount_reference.py`
(Python `html.parser` + `ElementTree` — an independent implementation whose answer is committed to
`books-fixture/expected.json` under `text`; regenerate only when the fixture epub is rebuilt, never
by copying the TS output back in).

### Hoops — the NBA simulation studio
An NBA sim & what-if studio as its own section, built to the plan in `HOOPS_PLAN.md` (tracking epic: GitHub #63). **Shipped so far: milestone 1, the read-model spine (#64) — `/hoops/teams` and `/hoops/teams/[tri]`; milestone 2, the RNG parity + engine port (#65, #66) — `lib/hoops/{rng,philox,blake2b,engine}.ts`; the Mac Mini PUSH endpoint (#73, wire contract kad-air/hoops-sim#24) — `POST /api/hoops/import`; and milestone 3, the matchup + box score (#67) — `/hoops` and `/hoops/game/[runId]`.** The engine now runs from a screen. Next up: the studio (#69), with the design spike (#68) ahead of it.

**Zero runtime dependency on the Mac Mini for READS.** Same shape as `/comics`, scaled up: heavy work (fitting a possession model against a 20GB DuckDB over 8TB of parquet) runs offline in `~/Code/hoops-sim`; what ships here is a bundle plus a TypeScript port of the engine. The Mini reaches OUT to push that bundle (below) — the hub never calls back to the Mini.

**🔴 Byte source, as of #73: the Mini PUSHES via `POST /api/hoops/import`; `hoops-data/*.json` is now a cold-start FALLBACK only, not the production path.** Before #73, the only way a fresh bundle reached the hub was a `git commit` of `hoops-data/*.json` plus a redeploy (`uv run hoops export-hub ~/Code/keith-hub/hoops-data` from `~/Code/hoops-sim`, still how `hoops-data/README.md` describes regenerating the COMMITTED files, still exercised by `npm run check:hoops`/`check:hoops:fixture` against whatever's on disk). Going forward, the phone/Mini pushes a fresh bundle directly and the DB updates without a deploy at all. `lib/hoops/data.ts` (`loadBundle()`) still reads the committed files with `fs` from `process.cwd()`, but it is called from exactly ONE place now: `lib/hoops/import.ts`'s disk-seed path.

**Cold-start choice, stated explicitly: committed bundle as fallback, volume state wins once anything real has landed.** `hoops_params.import_source` ('seed' | 'push') records which family produced the live data. `ensureHoopsImport()` (every hoops read, memoized per process) checks this FIRST: if it's already `'push'`, disk is never even read — a real push is permanently authoritative for the life of that Railway volume, so a stale committed bundle from a later `git push` to `main` (still possible during the transition) can never silently clobber a live push on the next redeploy. Until the first push, behaviour is unchanged from before #73: a redeploy carrying a refreshed committed bundle still auto-imports it (content-hash comparison, `writeBundle` in `lib/hoops/import.ts`), which is what keeps a fresh Railway volume non-blank on `/hoops` before the Mini has ever pushed.

**The wire contract (kad-air/hoops-sim#24) is capability-negotiated, asymmetrically on purpose.** `lib/hoops/contract.ts` is the ONE place the receiver's supported `SUPPORTED_FEATURES`/`SUPPORTED_PRICING_VERSION`/`REQUIRED_CONSTANTS` live — an unknown `feature` in the pushed envelope REJECTS (naming it), an unknown `constant` is silently ignored (the sender may add freely), a `constant` this receiver needs but doesn't get REJECTS (naming it, never defaulted), a `pricing_version` higher than supported REJECTS, a `generated_at` older than what's stored REJECTS (stale-replay protection), and an unchanged `content_hash` is a NO-OP (200, no rewrite). 🔴 `NO_CONTRACT_FALLBACK` in that file is the ONE named place a bundle with no `contract` block at all (the sender, kad-air/hoops-sim#23, may land after this receiver) gets treated as `pricing_version: 1, features: ["symmetric_off_def", "absorption"]` — do not inline that default anywhere else. The route also tolerates a bundle whose top-level `constants` block hasn't been promoted out of `hoops_params.json`'s own nested `constants` yet, merging in `hoops_players.json`'s `replacement_per36` (see `app/api/hoops/import/route.ts`'s own comment) — this merge is inert the moment the sender ships a real top-level `constants` block.

🔴 **`POST /api/hoops/import` auth deliberately diverges from `middleware.ts`'s `FEED_PASSWORD` convention, in the opposite direction.** A dedicated `HOOPS_IMPORT_TOKEN` env var (bearer, timing-safe compare via `crypto.timingSafeEqual`, length-checked first so it can't throw on a mismatched length), never `FEED_PASSWORD` — different blast radius, and a machine credential has to be rotatable without logging every device out of the hub. The route is exempted from `middleware.ts`'s matcher (alongside `api/auth`) and does its own auth entirely — **and fails CLOSED when `HOOPS_IMPORT_TOKEN` is unset**, the opposite of `middleware.ts`'s deliberate fail-OPEN when `FEED_PASSWORD` is unset (fine for a human cookie gate in local dev; would be a public endpoint that rewrites the entire read model here). Do not "fix" this divergence to match the middleware — it's commented in both files as deliberate. Generate the real token with `openssl rand -hex 32`, set it in the Railway dashboard and as a plain env var on the Mini (never behind `op` — see the global `CLAUDE.md`'s note on why a Mini push flow can't wait on a Touch ID prompt nobody's there to give).

**Transactional — validate the whole bundle, then swap in ONE SQLite transaction.** `lib/hoops/bundleValidation.ts`'s `validatePushedBundle` runs BEFORE the write (30 known franchises present and no others, every team ≥8 rostered players, the exact 1,230-game regular-season schedule count, no tied result, at least one line) — found necessary by falsification while building this: `decodeParams` alone validates `hoops_params.json`'s own internal shape and says nothing about whether the other five files have a PLAUSIBLE AMOUNT of content, and a bundle truncated to 5 players (of a real ~530) sailed through it and wrote successfully before this check existed. Beyond that gate, `lib/hoops/import.ts`'s `writeBundle` already runs inside `db.transaction()`, which rolls back on any thrown exception (e.g. better-sqlite3 refusing to bind a field a malformed row is missing) — a truncated or invalid bundle leaves the previous read model completely intact, verified directly by falsifying both gates and confirming the read model was bit-for-bit unchanged after each rejected POST.

**`generated_at` is surfaced, not just imported.** `HoopsMeta.generatedAt` (`getHoopsMeta()`, `lib/hoops/queries.ts`) already rendered on `/hoops/teams` before #73 ("Exported: <date>" in `components/hoops/TeamsClient.tsx`) — what changed is that `hcaPts`/`replacementPer36`/`valueAsOf` moved from a live `loadBundle()` (disk) read to columns on the `hoops_params` row itself (`import_source`/`hca_pts`/`replacement_per36`/`value_as_of`/`pricing_version`/`features_json`/`constants_json`, added by an additive migration in `lib/db.ts`), so they reflect whichever byte source is actually live instead of silently reading stale disk bytes forever once a push has happened. 🔴 **A pre-#73 DB row has `hca_pts IS NULL`** (added by the migration, never backfilled by a no-op hash match) — `importHoopsData`'s no-op check requires `state.hasScalars` in addition to a hash match, specifically so an existing production row backfills those columns on its very next boot instead of `meta.replacementPer36` reading `null` forever (which would throw on `app/hoops/teams/[tri]/page.tsx`'s `meta.replacementPer36.toFixed(2)`) — found and fixed by testing against a real pre-migration local DB, not assumed safe.

🔴 **Read-model tables are rewritten wholesale; user tables are never touched.** `hoops_params`/`teams`/`players`/`schedule`/`results`/`lines` are projections of the bundle (pushed OR seeded). `hoops_scratch` and `hoops_runs` are the user's own (roster experiments, saved sims) and the importer deliberately does not `DELETE` them. **Data flows one direction only: Mini → hub.** A roster edit made on the phone must never write back to hoops-sim's `data/roster_edits.json`, which drives the CLI — that's a two-writers-one-file bug that's very hard to see afterwards.

🔴 **`off - def` is the team's strength, not `off + def`.** hoops-sim's own convention (`rosterratings.py`: "off = +strength/2, def = -strength/2"), and `sim.py` consumes the halves separately as `home_off + away_def`. A positive `def` means points *allowed* above average, so a good defence reads negative. `netOf()` in `lib/hoops/rating.ts` is the single implementation; don't "fix" the minus sign. `lib/hoops/pricing.ts` (below) carries the same convention for RAW, uncentered strength.

**Honesty carries that are correctness, not polish** (every one of these is printed on hoops-sim's CLI output today and has to render in the UI): the ratings-mode choice is exposed with its caveat on screen, never as a tooltip; player value is labelled a model estimate with its as-of date; roster minutes are labelled pre-normalisation. The plan's ">30% roster churn" caveat can't be computed — the export doesn't carry churn — so instead of transcribing hoops-sim's league figure as if it had been measured here, the UI shows the *actual* |results − roster| disagreement from today's bundle (median/max, and a per-team flag above 5 pts). When the engine lands, the variance-honesty note and a visible, shareable `run_id` join this list.

**The pricing fixture (#24's last section) is BUILT and READY, but not yet assertable — the sender hasn't shipped it.** `lib/hoops/pricing.ts` is a pure, DB-free TS port of hoops-sim's `allocate_minutes`/`allocate_minutes_with_absorption`/`raw_team_strength`/`team_net_rating` (read from `~/Code/hoops-sim`'s `src/hoops/minutesmodel.py`/`rosterratings.py`/`availability.py`, not modified — that repo is out of scope for this change), reading every constant by name off `PricingConstants` (no hardcoded value). `scripts/check-hoops-pricing-fixture.ts` (wired into `prebuild`) looks for `hoops-data/hoops_pricing_fixture.json`; as of this writing that file doesn't exist yet (confirmed directly: `uv run hoops export-hub` still only produces the six read-model files plus the engine's own `hoops_fixture.json`), so the check prints an INFO note and exits 0 rather than failing everyone's build on an artifact outside this repo's control. The moment the sender ships that file, this check starts asserting against it for real — no code change needed here. 🔴 The exact JSON schema it expects is this receiver's OWN design (documented in the script's header comment) since #24 names the 5 required cases but not a byte-exact shape the way `hoops_fixture.json` already has — reconcile against the sender's actual output when it lands. 🔴 `net`/`off`/`def` here are RAW/uncentered — `league_mean_raw` is deliberately never sent over the wire (kad-air/keith-hub#66), so this module can only ever compute a raw strength or a delta, never an absolute recentered rating.

#### The matchup + box score (milestone 3, #67)

`/hoops` is the section home: home/away pickers, a neutral-court toggle, a ratings-mode row, and one accented **Sim**. `/hoops/game/[runId]` is one sampled game.

🔴 **The `run_id` is self-describing, and that is load-bearing.** `DEN-OKC-hb-3f2a9c1b0d4e5f6a` encodes home, away, court (`h`/`n`) and rating mode (`r`/`o`/`b`), so `/hoops/game/[runId]` reproduces the game **from the URL and nothing else** (`encodeRunId`/`parseRunId`, `lib/hoops/matchup.ts`). The alternative — a random id plus a `hoops_runs` row — would make a shared link depend on this device's DB, which is the property "reproducible forever" was supposed to buy. `hoops_runs` stays reserved for sims the user deliberately saves; it is not touched by this milestone. A malformed id parses to `null` (never throws) so the page 404s rather than 500s. `/hoops/game/new?home=&away=&mode=&neutral=` mints a fresh id and redirects, so a rendered result always sits at a stable URL.

🔴 **A sampled game must never reuse the matchup screen's simulation.** `possessionCounter` in `engine.ts` is scoped to the whole batch (a faithful port of `sim.py`), so replicate 0 of an `n=1` run is **not** replicate 0 of an `n=1000` run — measured: the same run_id gives DEN 128-137 at n=1 and 135-134 at n=1000. Feeding a sample-mode box score a multi-replicate simulation would produce a game its own run_id can never reproduce. `buildBoxscore` throws on the mismatch and `check-hoops-boxscore.ts` asserts the refusal.

**Where `lib/hoops/boxscore.ts` deliberately diverges from `hoops.boxscore`** — each forced by the export boundary (no DuckDB here), each changing a NUMBER, all four written up in that file's header:
1. **Participants.** Python's "last-game actives" branch is unreachable (no game logs in the bundle); the **season-typical rotation branch is ported exactly** (`selectRotation` — rank by the export's `minutes`, fill to 265 historical minutes, bounded 8–13 players, hoops-sim's own `ROTATION_FILL_MINUTES`/`ROTATION_MIN`/`ROTATION_MAX`). 🔴 Projecting the full 16–20 man roster instead was the first implementation and was **measurably wrong**: it deflated every rotation player's line ~40% (Maxey 15.4 projected vs 28.3 actual, −4.9 bias over 137 players) while every TEAM total stayed perfectly correct, because points come from the engine and shares renormalise. Only comparing against the bundle's independently-measured `game_rates` caught it.
2. **Non-PTS team level.** No team game logs, so the level is built as `Σ per36[stat] × allocated_minutes / 36`. 🔴 Do **not** "fix" this by summing per-GAME rates — a per-game rate is conditioned on the games that player appeared in, so summing 18 of them inflates the level ~30%.
3. **PTS shares** come off the same per36 × minutes basis as every other stat (Python uses ppg), so one roster edit moves all six stats coherently.
4. **No playoff concentration** (`playoffrotation`'s `share**alpha`). `effective_alpha(False) == 1.0` is an exact identity on the Python side, so regular-season output is unaffected.

**`lib/hoops/binomial.ts` is a bit-exact port of numpy's `random_binomial`/`random_multinomial`** — the box score allocates every integer stat with `stream(...).multinomial(total, shares)`, and numpy's binomial has two samplers (inversion at `p*n <= 30`, BTPE above) that consume different numbers of uniforms, so a port that picks the wrong one returns plausible integers while being silently desynchronised forever. Asserted against real numpy by `npm run check:hoops:multinomial`.

**Two new build gates, both in `prebuild`:**
- `npm run check:hoops:multinomial` — `hoops-data/hoops_multinomial_cases.json`, generated by running numpy 2.5 through hoops-sim's own `hoops.rng` (`scripts/gen_multinomial_cases.py`). 17 cases + 6 long sequences (1,090 draws). The sequences are long **because falsification demanded it**: with one draw per shape, five separate perturbations of the port went undetected; BTPE's rejection regions need hundreds of draws before they fire. The check measures its own branch coverage (inversion / BTPE / complement flip / early exhaustion / rejection redraws) and fails if any falls below a floor.
- `npm run check:hoops:boxscore` — seven kinds of evidence over the real bundle, each present because falsification showed the others couldn't see its failure. Most notably: the integer identity is asserted **against the engine's own realised score**, not just against the box score's internal total (nudging that total by +1 left all 2,150 other assertions green); pace→stat coupling is measured as a correlation (replacing each replicate's possession count with the league average is otherwise invisible); and player lines are anchored on **share of team points vs the bundle's measured `game_rates.pts`** (the absolute MAE carries a systematic −2.46 bias from the rotation-fill mechanism and cannot see a share error — mis-weighting threes as twos moves it 2.46→2.50, but moves the share metric 0.192→0.585).

**Honesty carries that render, not tooltips:** the variance note and the "how these lines were built" caveats on every box score (`VarianceNote` / `BoxScoreCaveats`), the `run_id` + fit version + data-as-of on every result (`RunProvenance` — the fit is printed *next to* the id because a Mini push can replace the model under an old link), the ratings-mode blurb, the participant basis and omitted-player count per team, and the histogram's "the answer is a distribution" paragraph naming the actual cloud width and quartiles.

**Key files:** `lib/hoops/types.ts` (the export's shapes), `blob-contract.ts` (what the engine expects the blob to be — the stale-blob guard's source of truth), `params.ts` (decode into flat `Float64Array` + stride, throws `StaleBlobError`; `expectVersion: null` is the fixture-only escape hatch), `data.ts` (read + hash the COMMITTED disk bundle — cold-start seed only, see above), `import.ts` (project either byte source into SQLite; `ensureHoopsImport`/`importHoopsData` = the disk-seed path, `importPushedBundle` = the push path), `contract.ts` (the wire-contract capability negotiation), `bundleValidation.ts` (the structural completeness gate on a pushed bundle), `pricing.ts` (the pure roster-pricing formula port, for the not-yet-assertable pricing fixture), `queries.ts` (server reads, all off the DB, never disk), `rating.ts` (**pure** — no fs/db, so the client can re-rank all three modes without a round trip), `nba-franchises.ts` (the 30 real franchises, as an external fact), `blake2b.ts` (hand-rolled because the engine runs in the browser too and Web Crypto has no blake2b; matches node:crypto on 510 inputs), `philox.ts` (Philox4x64 + numpy's `random`/`standard_normal`), `ziggurat.ts` (generated tables), `rng.ts` (coordinate-keyed streams), `engine.ts` (the possession loop), `binomial.ts` (numpy's multinomial/binomial, for the box-score allocation), `boxscore.ts` (**pure** — the two-mode box score; the studio re-runs it in the browser), `matchup.ts` (**pure** — the run_id encoding + the distribution summary), `run.ts` (the server glue: DB + engine + box score in ONE place so the routes and the SSR pages cannot drift into simulating different games). API: `app/api/hoops/import/route.ts` (the push endpoint), `app/api/hoops/teams/route.ts`, `app/api/hoops/sim/route.ts`, `app/api/hoops/boxscore/route.ts`. UI: `components/hoops/HoopsNav.tsx` (the section self-hosts its in-page nav — there is no global sub-tab bar to extend; #68's first question is answered in favour of SIBLING PAGES with an in-section switcher, so every result is linkable and server-renderable), `components/hoops/MatchupClient.tsx`, `components/hoops/BoxScoreTable.tsx` (the shared table + the three honesty blocks), `components/hoops/MarginHistogram.tsx`, `components/hoops/TeamsClient.tsx`, `app/hoops/page.tsx`, `app/hoops/game/[runId]/page.tsx`, `app/hoops/teams/*`.

#### The engine port (milestone 2)

`lib/hoops/engine.ts` is a port of hoops-sim's `sim.py::simulate_game`, and `lib/hoops/rng.ts` + `philox.ts` + `blake2b.ts` port `hoops.rng`. **Bit-exact parity with numpy was achieved and is asserted, not hoped for**: 480,000 draws (uniforms + normals, tail path included) verified bit-identical to numpy, and every per-replicate score/possession-count/OT value identical to Python across both fixtures.

🔴 **The RNG is Philox4x64, not PCG64** — `HOOPS_PLAN.md` §6 originally said PCG64 and was wrong (corrected there now). Philox is counter-based lane arithmetic, so it ports with plain 64-bit math and no 128-bit multiply.

🔴 **`lib/hoops/ziggurat.ts` is generated, not authored.** numpy's `standard_normal` is a 256-level ziggurat whose tables are C constants not exposed to Python and not shipped in the wheel. They were recovered two independent ways that agree bit-for-bit: empirically (on the fast path `x = rabs * wi[idx]`, so one raw uint64 and one normal from two identically-seeded streams give `wi[idx] = |x| / rabs` exactly), and by locating that recovered block verbatim inside numpy's compiled `_bounded_integers` .so, which yielded the adjacent `ki`/`fi` tables. `ki[0] * wi[0]` reproduces `ziggurat_nor_r` to the last ulp — that's what confirms `ki` is the normal table, not the exponential one beside it. The file's own header records the method. If a future numpy changes these, the fixture fails, which is correct.

🔴 **Relative imports inside `lib/hoops/` use explicit `.ts` extensions** (`from "./philox.ts"`), and `blob-contract` / `nba-franchises` are `.ts` modules rather than JSON. **Do not "normalise" either.** Both exist so plain `node` can execute `scripts/check-hoops*.ts` directly against the REAL engine modules — Node's type stripping resolves only explicit `.ts` specifiers, and it requires import attributes for JSON. Webpack accepts the same specifiers (verified), so nothing is lost. Consequences: `package.json` pins `engines.node >= 24` (type stripping shipped unflagged in 23.6) with a matching `.nvmrc`, and `tsconfig.json` sets `target: ES2020` for the Philox BigInt literals.

**Not ported, deliberately:** `LineupPlan` (the L3 per-slot on-court delta). The committed export carries no lineup plan, and Python's `lineups=None` path is bit-identical to an all-zero plan — that's the path reproduced. It's a stated omission, not a silent approximation.

**Measured throughput** (Mac Mini, node): a 2000-replicate distribution takes **~606ms**, ~0.66M possessions/sec — only ~3× slower than vectorized numpy, but well above `HOOPS_PLAN.md` §0.2's "tens to a few hundred ms" estimate, which the live-while-editing studio (milestone 4) is premised on. **~53% of that is the BigInt Philox** (319ms of 606ms is RNG alone), so 32-bit limb arithmetic in `philox.ts` is the obvious lever, with the fixture as the safety net proving the optimisation changed no draw. 500 replicates is 172ms if fewer replicates turn out to be acceptable.

**The gates: `npm run check:hoops` and `npm run check:hoops:fixture`, both wired as `prebuild`.** It is deliberately *not* the export agreeing with itself — hoops-sim's own `validate_export` already does the producer-side checks. This asserts the committed bundle against things true independently of it: the real NBA (30 franchises with fixed conference/division assignments, 82 games each, 1,230 total, and games that cannot end tied), mathematics (probability rows sum to 1, CDFs are monotone 0→1, the PPP grid matches its declared min/max/step), and the engine's declared contract (`PARAM_VERSION` must match, or a blob from an older fit fails the build). It also pins both landmines carried over from hoops-sim: no score column may reappear in `hoops_lines.json`, and no result may be a tie. Falsification-tested at merge against 14 perturbations (stale `PARAM_VERSION`, dropped team, wrong division, null/NaN rating, tied final, resurrected score column, broken probability row, non-monotone CDF, missing schedule game, mis-joined line, unknown player team, truncated `theta_grid`, fixture swapped for the production fit) — all 14 failed the check.

`check:hoops:fixture` is the cross-implementation one, and it has **two halves that are not redundant** — which was established by falsification, not assumed:

- **`hoops_fixture.json`** — the synthetic fixture hoops-sim's own `hoops verify` also asserts. Five laddered rungs (seeding digest → raw Philox → uniforms → ziggurat normals → box score) so a break localises itself. Its `ParameterSet` is deliberately synthetic so the pinned result doesn't move when the model is re-fit. It is the **only** check that exercises `pace_sigma`/`efficiency_sigma`: production ships both at **0.0**, so against the real blob you can delete both latents entirely and nothing notices.
- **`hoops_realblob_cases.json`** — Python `simulate_game` over the exact rounded blob that ships, 5 matchups × 200 replicates. It is the **only** check that reaches overtime (39 replicates do), the end-game time buckets, the margin buckets, and margin feedback inside the end-game window — an 8-replicate fixture never ties. Regenerate with `cd ~/Code/hoops-sim && uv run python ~/Code/keith-hub/scripts/gen_real_blob_cases.py` **whenever the blob is regenerated**; it is keyed to the blob's sha256 and fails loudly when they drift, deliberately, because a new fit means the cross-implementation evidence has to be re-established rather than assumed. The check also fails if the cases stop reaching OT, so coverage can't quietly shrink while staying green.

Engine falsification at merge: HCA not halved, margin feedback inside the end-game window, the duration row taken from the post-transition start type, the dispersion shrink dropped, a pending possession redrawn instead of resumed, the possession flip removed, the opening tip inverted, the end-game time bucket off by a second, the margin bucket boundary off by one, OT not triggered on a tie, and each latent dropped — every one caught by at least one half. (One perturbation is genuinely undetectable and correctly so: `searchsorted` left vs right differ only when `target_ppp` lands exactly on a grid point, where both sides interpolate to the same theta.)

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

### Charts (the chord-chart library + setlists)
The **Charts** section (`/charts`) is a personal library of guitar chord charts plus named **setlists** built from that library. It's the one section explicitly built to work offline — the use case is playing a gig with no signal.

**Data model — library + many-to-many setlists.** The flat `charts` table (`lib/charts.ts`) is the full library: every uploaded/pasted chart. A **setlist** (`setlists` table) is a named, ordered selection that *references* library charts through the `setlist_charts` join (`lib/setlists.ts`), so the same chart can live in multiple setlists and editing a chart updates it everywhere. Both join FKs are `ON DELETE CASCADE` (`foreign_keys = ON`): deleting a library chart drops it from every setlist; deleting a setlist drops its membership rows. There is no "default setlist" — the library stands on its own.

**Routes / pages** (all under `app/charts/`):
- `/charts` — the library (`ChartsClient`): list with a client-side, localStorage-persisted **sort** (Recently added / updated / Title / Artist), `+ Add` / `Bulk .txt` create flows, per-row delete, and a link to Setlists. **Editing an existing chart does NOT live here** — it moved to the chart's own page. Add/Bulk/Delete are disabled while offline (writes need the network).
- `/charts/[chartId]` — the autoscroll viewer (`ChartViewerClient`): the configurable-speed autoscroll, font zoom, wake-lock, progress bar — all client-side. Hosts the **Edit** button (opens the shared `ChartForm`), disabled while offline. An optional `?setlist=<id>` query puts the viewer in **setlist mode**: named back link, a "Next ▸" shortcut to the following song (which carries the `?setlist=` chain forward), and the auto-start countdown. **The setlist context is resolved client-side, not from `searchParams`**: the server bakes ALL of the chart's setlist memberships into the render (`getChartSetlistContexts` in `lib/setlists.ts` — setlist id/name + next song each), and the client picks the active one from `location.search` after mount. This is load-bearing for offline: the SW's `charts-pages` cache holds ONE query-less render per chart (warming fetches `/charts/<id>`; matching uses `ignoreSearch`), so anything derived server-side from the query would be missing when a cached page is opened offline from a setlist — which is exactly how the Next button used to disappear at a gig. Because setlist names and next-pointers are baked into chart pages, all three warm keys (OfflineWarm, ChartsClient, SetlistDetailClient) fold in the setlist's `updatedAt`/name and member order, so renames and reorders re-warm member chart pages, not just the detail page.
- `/charts/setlists` — setlists index (`SetlistsClient`): list/create/delete setlists.
- `/charts/setlists/[id]` — setlist detail (`SetlistDetailClient`): the setlist's ordered charts with **drag-to-reorder** (the dependency-free pointer drag — transforms-to-DOM during drag, commit-once on drop), an **Add from library** picker (charts not yet in the setlist), remove-from-setlist, rename, delete, and the **Available offline** toggle.
- `ChartForm` (`app/charts/ChartForm.tsx`) is the shared create/edit form used by both the library (`mode: "new"`) and the viewer (`mode: "edit"`).

**Voice follow — the viewer's second scroll mode.** The control bar has a Timer/Voice segmented switch (persisted globally under `setlist-scrollmode`; the Voice segment renders disabled when SpeechRecognition is unavailable — notably some iOS PWA contexts). In Voice mode the play button becomes a mic: SpeechRecognition (continuous + interim, webkit-prefixed on Safari) listens to the words being **sung**, and `lib/lyric-follow.ts` aligns the transcript against the chart's lyrics to find the current line, which gets an accent highlight and is eased to ~35% viewport height (`VOICE_ANCHOR`). Matching design (all in `lib/lyric-follow.ts`, pure/DOM-free so it's testable without a browser): lyric words are extracted from `parseChart` blocks skipping chord-only lines and section headers (so singing the word "chorus" never matches a `[Chorus]` label); `LyricMatcher.feed` greedily aligns the last 8 recognized words (fuzzy: exact / shared-prefix ≥4 / edit-distance-1 for ≥5 chars) inside a local window around the last position, is **forward-only** — a stray match can't yank the chart backwards — only considers words heard **since the last accepted match** (the matcher tracks a consumed-count into the recognized stream; `sessionRestarted()` resets it when the viewer attaches a fresh recognizer). This fresh-words rule is load-bearing for repetitious songs: interim results re-deliver the same tail constantly, and already-consumed words' only *forward* occurrence is the next similar line, so without it a pure re-feed hopped the highlight off a line before the singer finished it (and dragged tap-back repositioning forward again). The matcher also scales the evidence bar with jump distance measured in **lyric lines**: staying on the current line or advancing to the following line needs ≥2 word hits (1 for a lone word ≥4 chars), but landing anywhere farther — skipping a line, hopping to a later chorus — is a leap needing ≥ `FAR_NEED` = 5 hits, and among qualifying candidates the **nearest wins outright** so repeated lines resolve to their closest occurrence ahead instead of a later section; repositioning is manual by **tapping any lyric line** (voice mode only → `seekToBlock`). Recognition sessions end on their own (silence, engine whims), so `onend` restarts with a **fresh recognizer instance** while following (re-`start()`ing a used one throws on Safari); fatal errors (`not-allowed`, `audio-capture`) stop the follow and surface in the status slot; `network` errors count consecutively (reset on any result) and stop with a "needs a connection — switch to Timer" message when offline or after 3 in a row, because most engines recognize server-side (iOS/Chrome) and the restart loop would otherwise spin forever at an offline gig — `service-not-allowed` while offline gets the same message instead of the misleading mic-denied one. The setlist auto-start countdown fires whichever mode is active (via `startEngineRef`), wake lock is held while listening, and the active-line highlight uses negative-margin+padding so text never shifts. Rendered rows carry `data-block={parseChart block index}` — that attribute is the matcher→DOM contract for both highlight and follow-scroll. Touch/scroll does **not** pause voice follow (peeking ahead is fine; the next match re-anchors) — and as of the nudge-friendly timer change, touch doesn't pause timer autoscroll either (see below).

**Timer mode is nudge-friendly.** A manual touch/wheel while autoscrolling does NOT pause playback — on stage a stray brush of the screen must never silently stop the chart; pausing is the play button's job. While a finger is down, the rAF loop emits no travel (`touchActiveRef`) so it doesn't fight the drag, then resumes from wherever the nudge left the page. Speed is **seven discrete notches** (`SPEED_NOTCHES`, 8–38 px/sec — the usable bottom fifth of the old free 8–160 slider), persisted per-song as px/sec (`setlist-speed:<id>`, old free-slider values snap to the nearest notch); a song with no stored speed starts at the LOWEST notch — deliberately not "last used". The setlist pre-roll countdown is 15s and its pill is anchored at the top of the viewport: any scroll cancels the countdown, so while it's visible the page is at scroll top, where the pill covers the title header rather than lyrics.

**API** (`app/api/charts/*` for the library — unchanged; `app/api/setlists/*` for setlists): `GET/POST /api/setlists`, `GET/PUT/DELETE /api/setlists/[id]` (PUT takes `name?` and/or `offline?`), `POST /api/setlists/[id]/charts` (`{ chartId }`, appends), `DELETE /api/setlists/[id]/charts/[chartId]`, `POST /api/setlists/[id]/reorder` (`{ ids }`).

**Offline support — opt-in per setlist, reachable from the homepage.** The guarantee is the whole path: cold-start the PWA at `/` with no signal → Charts → Setlists → an offline setlist → its charts. Pieces:
- **Dedicated SW caches** (`app/sw.ts`): a `NetworkFirst` rule for `/charts` and `/charts/*` writes to the `charts-pages` cache, and a sibling rule for `/` (the PWA start_url) writes to `app-shell` — both ordered **before** `...defaultCache` so they win those routes (defaultCache's own page cache expires after 24h/32 entries, too fragile for the gig flow; the offline homepage serves a stale feed but its masthead/Contents navigation is what matters). Online (or within the 4s timeout) the network wins, so edits show immediately; offline they serve the last-cached render. The chart text is baked into the SSR'd HTML and all viewer interactivity is client-side, so a cached page is fully functional offline with zero network. The charts rule still caches any chart page fetched online (so a chart you open is cached on demand — full document loads via the rule itself, in-app navs via the viewer's self-warm below). **Both rules exclude RSC requests** (`RSC: 1` header) so these caches only ever hold HTML documents — flight payloads used to get cached under `?_rsc=` URLs and could be served as the "HTML" of an offline document load (blank page). Offline client-side navs instead miss/fail the flight fetch and Next falls back to a full browser navigation, which lands on the cached HTML. **Cache keys are normalized to the query-less URL** (`cacheKeyWillBeUsed` strips the search on both reads and writes): Cache API matching is insertion-ordered, so without this a query-full document load (`/charts/<id>?setlist=<id>`, `/?category=music`) stranded a second entry that permanently shadowed later re-warms — and the offline homepage cold start at bare `/` could miss entirely because the only cached entry was query-full. An activate-time sweep purges any legacy query-full entries (including the old `?_rsc=` flight payloads) from both caches.
- **App-shell warming from any page.** `OfflineWarm` (`components/OfflineWarm.tsx`, mounted in `app/layout.tsx`, renders nothing) runs on app open, `online` events, and PWA resume (`visibilitychange`): it pulls `GET /api/setlists/offline` (`getOfflineSetlists()`) and warms `/charts`, `/charts/setlists`, and every offline-flagged setlist's detail + member chart pages, keyed on `id@updatedAt` like the per-page warmers. This is what makes the homepage → charts path survive when the user hasn't visited the Charts section in weeks — the per-page warmers below never ran in that case. It bails when the page isn't SW-controlled yet (first install; ServiceWorkerRegister's controllerchange reload re-mounts it). It also requests `navigator.storage.persist()` (best effort — stops iOS reclaiming the caches from a PWA that sat unopened for weeks) and listens for `controllerchange`: when a deploy's SW takes over mid-session it resets the warm key and re-fetches every page, so cached HTML always references the NEW build's precached chunks (an epoch counter keeps an in-flight warm from recording a pre-update run as complete).
- **Per-setlist cache warming.** The library no longer warms every chart (that was the old single-setlist behavior). Only setlists with `offline = 1` warm their member chart pages: `SetlistDetailClient` warms a setlist's charts when its toggle is on, and `ChartsClient` warms all offline-flagged setlists' pages on load (`getOfflineSetlists()` feeds it the chart ids). Each warms by `fetch()`ing the page (covers cold relaunch / shared link) and `router.prefetch()`ing the RSC payload (covers in-app `<Link>` nav); page fetches land in `charts-pages` (whose `NetworkFirst` rule uses `matchOptions: { ignoreSearch: true }` so a chart opened from a setlist via `/charts/<id>?setlist=<id>` hits the same cached entry as the query-less warmed page). Warming is keyed on each member chart's `id@updatedAt` (not just the member set) so editing a chart re-warms its page instead of serving a stale render offline, and is guarded by a ref so it runs at most once per unchanged set per session. Status line: "Saving for offline…" → "✓ Saved for offline", or "● Offline · charts available" when disconnected. Writes (add/edit/delete/reorder/rename/toggle) still require the network — offline is read/play only.
- **Self-warming on visit and mutation.** In-app `<Link>` navigations never issue a document request (only an RSC flight fetch, which the charts rules ignore), so the NetworkFirst rule alone can't cache a page you browsed to in-app. Each charts surface therefore keeps its own cached render fresh with a small `fetch()` of its query-less document URL: `ChartViewerClient` on mount and after an in-page edit (keyed `chart.id`/`updatedAt` — covers charts outside any offline setlist), `SetlistDetailClient` when NOT offline-flagged (the flagged warm covers itself), and `ChartsClient`/`SetlistsClient` whenever their list state changes (so a chart or setlist added/deleted this session doesn't ghost in the offline copy until the next app open).
- **Offline fallback page** (`public/offline.html` + the `fallbacks` option in `app/sw.ts`): a document navigation that misses network AND every cache (a chart never warmed, opened with no signal) gets a branded static page with links to `/charts`, `/charts/setlists`, and `/` (all always warmed) plus a retry button, instead of the browser's network-error page. It's a static file in `public/` on purpose: the public/ scan precaches it with a content-hash revision, and it's fully self-contained (inline styles, no build chunks) so it renders even when a newer deploy purged the old build's assets. It auto-reloads on the `online` event — the fallback is served UNDER the original URL, so the reload retries the navigation the user actually wanted. The middleware matcher excludes it (like sw.js/manifest) so the SW's install-time precache can't cache a login redirect as the fallback.
- **No reload out from under a live chart.** `reloadOnOnline: false` in `next.config.mjs` — @serwist/next's default reloads the window on every `online` event, which on a flapping gig network would yank a mid-song chart (scroll position, autoscroll, wake lock all die). Same idea in `ServiceWorkerRegister`: the controllerchange reload only fires on FIRST install (needed so warm fetches populate the caches) or off the `/charts*` routes — a deploy landing mid-song updates caches via OfflineWarm's re-warm instead, and the page picks up the new build on its next natural navigation.

## Deployment

**Hosted on Railway** at `hub.keithadair.com`. Auto-deploys on push to `main`.

- Railway builds with Nixpacks (auto-detects Next.js). No Dockerfile needed.
- Railway sets `PORT` dynamically — Next.js respects it automatically.
- Persistent volume mounted at `/app/data` holds the SQLite database (all persistent state — items, push subscription, release-notify date — lives in the DB's `kv` table).
- The background poller starts on process boot via `instrumentation.ts` (Next.js instrumentation hook with `experimental.instrumentationHook: true` in `next.config.mjs`).
- Git version metadata: `next.config.mjs` tries `git rev-parse` first, falls back to Railway's `RAILWAY_GIT_COMMIT_SHA` env var.
- DNS: CNAME record `hub` → Railway's provided CNAME target, managed in DigitalOcean DNS. Domain registered at Squarespace.

### Auth
`middleware.ts` also carries one non-auth rule, first in the handler: the hidden Tracking section's 404 (see "Tracker data").

Password-protected via Next.js middleware (`middleware.ts`). A `hub-auth` httpOnly cookie gates all routes except `/login`, `/api/auth/*`, static assets, the manifest, the service worker, and `offline.html` (the SW precaches the offline fallback at install time — gating it would cache the login redirect as the fallback). The cookie value is **not** the password itself — `lib/auth.ts` derives a stable HMAC-SHA256 token from `FEED_PASSWORD` (via Web Crypto so it works in both Edge middleware and Node API routes) and compares tokens, so the plaintext password never leaves env. If `FEED_PASSWORD` is unset the middleware waves everything through (local dev). API routes that fail auth return 401; everything else 302-redirects to `/login`. Log out via the gear menu.

The login/logout `POST` handlers (`app/api/auth/{login,logout}/route.ts`) must return **303** redirects, not the default 307. iOS Safari preserves the POST method on 307 and tries to POST to `/`, which fails with "Safari can't open the page because the address is invalid" until manual refresh. Redirects also go through `publicUrl()` in `lib/auth.ts` so Railway's forwarded `host`/`proto` headers win over the localhost `request.url` on the internal network.

### Local dev
`npm run dev` on port 3000. Copy `.env.example` to `.env` and fill in the same vars Railway has set. If `FEED_PASSWORD` is unset, auth is bypassed (so local dev works without logging in).

### Files never committed
`.env`, `data/the-feed.db`

## Environment variables
- `FEED_PASSWORD` — password for the login gate (unset = auth bypassed, for local dev)
- `HOOPS_IMPORT_TOKEN` — bearer token the Mac Mini uses to `POST /api/hoops/import` (kad-air/keith-hub#73). Generate with `openssl rand -hex 32`. **Unset = the route refuses every request** — the opposite of `FEED_PASSWORD`'s unset behavior, deliberately (see "Hoops" above). Never behind `op` on the Mini side.
- `BOOKS_API_KEY` — device credential for `/opds/{key}/…` and `/kosync/{key}/…` (Books section).
  Generate with `openssl rand -hex 32`. **Unset = both endpoint families refuse every request**
  (fail CLOSED, same convention as `HOOPS_IMPORT_TOKEN`, opposite of `FEED_PASSWORD`).
- `ADOBE_ADEPT_KEY` — Adobe account RSA private key (PKCS#8 DER, base64) used to strip ADEPT DRM
  from an uploaded epub (see the Books "DRM" section). **Unset = DRM'ed uploads are refused with a
  reason, never ingested broken** (fail CLOSED); a DRM-free library needs nothing here. Optional
  today, and slated to become mostly vestigial once `.acsm` fulfilment lands (anonymous activation
  stored in the `kv` table).
- `BLUESKY_IDENTIFIER` — Bluesky handle (e.g. `keithadair.com`)
- `BLUESKY_APP_PASSWORD` — Bluesky app password (not account password)
- `CRAFT_API_KEY` — Craft Connect API key for tracker collections
- `VAPID_PUBLIC_KEY` — Web Push VAPID public key (also exposed client-side as `NEXT_PUBLIC_VAPID_PUBLIC_KEY`)
- `VAPID_PRIVATE_KEY` — Web Push VAPID private key
- `VAPID_SUBJECT` — `mailto:` URI for VAPID identification

## Git auth
The repo pushes via HTTPS with a PAT stored in `~/.git-credentials`. Check the `<old>..<new>  main -> main` line to confirm the push actually happened — macOS Keychain helpers may print a benign `failed to store: -25308` warning that is NOT a push failure.
