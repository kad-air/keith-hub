# The Feed

A personal content hub for intentional media consumption. Aggregates RSS, podcasts, and Bluesky into a finite, triage-first feed; surfaces Craft-backed trackers for books / music / TV / movies / games; and indexes Marvel Unlimited reading orders. Installable as an iOS PWA. Single user, password-protected.

See `PRODUCT_PLAN.md` for the design principles and `CLAUDE.md` for the full architecture guide.

Stack: Next.js 14 (App Router) · SQLite (better-sqlite3) · Tailwind · Serwist (PWA). Hosted on Railway at `hub.keithadair.com`, auto-deploys on push to `main`.

## Local dev

```bash
npm install
cp config/feeds.example.yml config/feeds.yml   # edit sources
cp .env.example .env                           # edit credentials
npm run dev                                    # http://localhost:3000
```

If `FEED_PASSWORD` is unset, the middleware skips auth so local dev works without logging in. The poller starts on boot via `instrumentation.ts`.

## Commands

```bash
npm run dev      # Dev server
npm run build    # Production build — the type-check gate (no test suite)
npm run start    # Production server
npm run lint     # next lint
```

## Runtime inspection

`node scripts/inspect.mjs help` — read-only CLI for checking what the running Feed actually has in the DB / rendered in HTML. Reach for it before poking sqlite or curl by hand.

## Environment variables

See `.env.example`. Required for a full build: `FEED_PASSWORD` (login gate), `BLUESKY_IDENTIFIER` + `BLUESKY_APP_PASSWORD` (AT Protocol fetch + write), `CRAFT_API_KEY` (trackers), `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` + `VAPID_SUBJECT` (Web Push / release alerts).

## Repo layout

- `app/` — Next.js App Router pages + API routes (feed, saved, read, trackers, comics, auth, push, service worker)
- `components/` — React components (Masthead, Contents overlay, FeedClient, FeedCard, TrackerClient, AppMenu, etc.)
- `lib/` — SQLite, queries, fetchers (RSS + Bluesky), Craft client, push, auth, types
- `config/feeds.yml` — source of truth for feed sources (committed alongside `feeds.example.yml`)
- `scripts/` — `inspect.mjs`, icon + comics-data generators
- `public/` — manifest, icons, generated service worker

## Deployment

Railway builds with Nixpacks. Persistent volume at `/app/data` holds `the-feed.db` (items, per-item state, push subscription, comic state, release-notify guard). See `CLAUDE.md` → Deployment for DNS, 303-vs-307 redirect gotchas, and the hand-rolled manifest link that keeps iOS PWA install working.
