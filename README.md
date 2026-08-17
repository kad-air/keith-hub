# The Feed

A personal content hub for intentional media consumption. One screen for everything new across your blogs, podcasts, and Bluesky — plus the trackers and reading lists you keep elsewhere — designed so you can scan, triage, and put your phone down.

Installable as an iOS PWA. Single user, password-protected. Hosted at `hub.keithadair.com`.

## What it's for

The Feed replaces the compulsive Reddit/Twitter check with something finite and deliberate. You open it, you see what's new, you decide what's worth your attention, and then you close it. The app is a triage layer — it surfaces what arrived; the native apps (Apple Podcasts, Marvel Unlimited, the publication's own site) handle the actual reading and listening.

### Design principles

- **Finite, not infinite.** No infinite scroll. You reach the end and you're done.
- **Triage, not consumption.** Scan, save, dismiss here. Read or listen there.
- **Config over UI.** Sources are managed by editing a YAML file. There's no admin screen.
- **Speed and beauty are features.** Server-rendered, sub-second loads, magazine-style layout. It needs to feel good to open.
- **One person, one purpose.** No multi-user, no sharing, no algorithms learning from you.

## What you can do

### Read the feed

The home view (**Today**) is everything new from your sources, interleaved so categories don't clump. RSS articles, podcast episodes, music/book/film reviews, and Bluesky posts share one stream — with reviews and podcasts weighted ahead of social.

- **Tap a card** to open the original in a new tab. The card disappears from Today and lands in **Read** history.
- **Swipe right** to save for later. **Swipe left** to dismiss without opening. (On desktop, hover for save / dismiss / clear-above buttons.)
- **Long-press** (or press `c`) to clear the focused card and everything above it — a quick way to bulk-dismiss what you've already scanned.
- **Pull down** to refresh. Or just wait — the poller pulls new content every ~15 minutes, and the app silently refreshes when you return to it.
- **Filter by category** with the tabs across the top (All / Reading / Tech / Books / Music / Film / Podcasts / Bluesky).
- A **"That's enough for now"** button at the bottom dismisses everything visible in one tap.

Bluesky posts render with full rich content: images, link cards, quoted posts, reply context, repost banners. You can like, repost, and follow directly from the card without leaving the app.

### Saved & Read

- **Saved** keeps anything you swiped right on, newest first. It lives forever — your reading list across every source in one place.
- **Read** is the append-only log of everything you actually opened. Re-opening from here bumps it to the top. Items you only dismissed never show up here, so it stays a real history of what you engaged with.

### Trackers — retired

The **Tracking** sections (Books / Music / TV / Movies / Games) mirrored Craft.do collections. **Stow now handles the media backlog, so the section is switched off** — set `TRACKERS_ENABLED = true` in `lib/tracker-config.ts` to bring it back; the code is all still here.

### Books

A personal EPUB library that doubles as an ebook server. Upload epubs from any device; the hub
reads each file's own metadata for title, author and series, and serves the library over **OPDS**
to real e-readers — an [Xteink X3](https://github.com/crosspoint-reader/crosspoint-reader) running
CrossPoint firmware, and Readest on iOS. It also runs a **KOReader sync server**, so your place in
a book follows you between the e-reader and your phone.

The trick that makes that work: a book is identified by a hash of its actual bytes, not its title
or filename. So the hub never rewrites a stored file — editing a book's metadata changes the
library card, never the book — and you always download onto a device *from the library* rather
than copying files around. Organisation is metadata, not folders: rearrange your shelves however
you like and nothing notices.

Replaced a self-hosted [Stump](https://github.com/stumpapp/stump) server that ran on a Mac Mini;
see `BOOKS_PLAN.md` for the design and the invariants.

### Comics

The **Library** section indexes Marvel Unlimited reading orders (Hickman-era X-Men and Avengers/Secret Wars) as checklists. Tap an issue and the OS hands off to the Marvel Unlimited iOS app at the right page. Read state syncs back so you can see your progress per storyline.

### Release alerts — off with the trackers

Release-date pushes existed only for the tracker collections, so the gear menu's toggle is hidden while Tracking is. It returns with the same flag.

### Themes & navigation

- Auto / Light / Dark theme toggle in the gear menu (matches iOS browser chrome).
- **⌘K / Ctrl+K** opens a section jumper — type to filter, Enter to go.
- Keyboard shortcuts throughout: `j`/`k` to navigate, `o`/`enter` to open, `s` to save, `x` to dismiss, `r` to refresh, `g h`/`g s`/`g r` to jump, `?` for the full list.

## Adding sources

`config/feeds.yml` is the admin panel. Add an RSS URL, a podcast feed, or a Bluesky account/feed/timeline reference; commit; the next poll cycle picks it up. Removing a source from the YAML cleans it (and its items) out of the database automatically.

---

## For developers

Stack: Next.js 14 (App Router) · SQLite (better-sqlite3) · Tailwind · Serwist (PWA). Hosted on Railway, auto-deploys on push to `main`. See `CLAUDE.md` for the full architecture guide.

### Local dev

```bash
npm install
cp config/feeds.example.yml config/feeds.yml   # edit sources
cp .env.example .env                           # edit credentials
npm run dev                                    # http://localhost:3000
```

If `FEED_PASSWORD` is unset, the middleware skips auth so local dev works without logging in. The poller starts on boot via `instrumentation.ts`.

### Commands

```bash
npm run dev      # Dev server
npm run build    # Production build — the type-check gate (no test suite)
npm run start    # Production server
npm run lint     # next lint
```

### Runtime inspection

`node scripts/inspect.mjs help` — read-only CLI for checking what the running Feed actually has in the DB / rendered in HTML.

### Environment variables

See `.env.example`. Required for a full build: `FEED_PASSWORD`, `BLUESKY_IDENTIFIER` + `BLUESKY_APP_PASSWORD`, `CRAFT_API_KEY`, `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` + `VAPID_SUBJECT`.

### Repo layout

- `app/` — Next.js App Router pages + API routes
- `components/` — React components
- `lib/` — SQLite, queries, fetchers (RSS + Bluesky), Craft client, push, auth, types
- `config/feeds.yml` — source of truth for feed sources
- `scripts/` — `inspect.mjs`, icon + comics-data generators
- `public/` — manifest, icons, generated service worker
