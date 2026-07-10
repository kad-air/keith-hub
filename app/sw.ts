/// <reference lib="webworker" />
import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig, SerwistPlugin } from "serwist";
import { NetworkFirst, Serwist } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    // Injected by @serwist/next at build time.
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

// Normalize cache keys to the query-less URL for both reads AND writes. The
// Cache API's `put` only replaces entries whose URL matches exactly, and
// `match` with ignoreSearch returns the entry in INSERTION order — so without
// this, a query-full document load (`/charts/<id>?setlist=<id>`, or
// `/?category=music` on the homepage) would strand a second entry that
// permanently shadows every later query-less re-warm. One key per path means
// the freshest render always wins, and the offline homepage cold start at `/`
// can't miss just because the last online visit carried a query.
const stripSearchFromCacheKey: SerwistPlugin = {
  cacheKeyWillBeUsed: async ({ request }) => {
    const url = new URL(request.url);
    url.search = "";
    return url.href;
  },
};

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  // When a document navigation can't be served from network OR cache (a chart
  // that was never warmed, opened at a gig with no signal), serve the branded
  // static fallback instead of the browser's network-error page. The page is
  // `public/offline.html` — fully self-contained (inline styles, no build
  // chunks) so it renders even when nothing else survived, and precached with
  // a content-hash revision by @serwist/next's public/ scan. Serwist wires
  // this plugin into every runtimeCaching handler below.
  fallbacks: {
    entries: [
      {
        url: "/offline.html",
        matcher: ({ request }) => request.destination === "document",
      },
    ],
  },
  runtimeCaching: [
    // The homepage is the PWA start_url — it MUST render offline or the user
    // can't reach the Charts section at a gig with no signal. defaultCache
    // only gives page documents a shared 24h/32-entry cache ("others"), which
    // silently expires; this dedicated rule keeps the last render of `/`
    // indefinitely. The feed content will be stale offline (API calls fail
    // gracefully), but the masthead + Contents navigation is what matters.
    // Every online visit to `/` refreshes the entry. Like the charts rule
    // below, RSC requests are excluded — see that rule's comment.
    {
      matcher: ({ url, sameOrigin, request }) =>
        sameOrigin &&
        request.headers.get("RSC") !== "1" &&
        url.pathname === "/",
      handler: new NetworkFirst({
        cacheName: "app-shell",
        networkTimeoutSeconds: 4,
        // Key + match on the query-less URL: the feed's SSR HTML is identical
        // for every ?category= (the client resolves the tab from the URL), and
        // the PWA cold-starts at bare `/` — a query-full entry must never
        // shadow or miss it. See stripSearchFromCacheKey.
        plugins: [stripSearchFromCacheKey],
        matchOptions: { ignoreSearch: true },
      }),
    },
    // The Charts section gets a dedicated NetworkFirst cache so chord charts
    // stay available offline — the use case is playing a gig with no signal.
    // Online (or within the 4s timeout) the network wins so edits show up
    // immediately; offline it falls back to the last-cached render of each
    // page. The chart text is baked into the SSR'd HTML and the viewer's
    // interactivity (autoscroll, zoom, wake-lock) is entirely client-side,
    // so a cached page is fully functional offline. Warming: OfflineWarm (in
    // the root layout) warms /charts, /charts/setlists, and every
    // offline-flagged setlist's pages on each app open; ChartsClient +
    // SetlistDetailClient re-warm when visited. This rule still caches any
    // chart page fetched online (so a chart you open is cached on demand).
    // It must precede defaultCache so it wins the /charts* routes.
    //
    // RSC requests (client-side navigations; `RSC: 1` header) are excluded so
    // this cache only ever holds HTML documents. Without the exclusion,
    // flight payloads got cached under `?_rsc=` URLs and — because matching
    // ignores the query string — could be served as the "HTML" for an offline
    // document load (a blank/garbled page). Offline client-side navs now
    // either hit defaultCache's pages-rsc entry or fail the flight fetch, and
    // Next falls back to a full browser navigation, which lands on the cached
    // HTML here.
    {
      matcher: ({ url, sameOrigin, request }) =>
        sameOrigin &&
        request.headers.get("RSC") !== "1" &&
        (url.pathname === "/charts" || url.pathname.startsWith("/charts/")),
      handler: new NetworkFirst({
        cacheName: "charts-pages",
        networkTimeoutSeconds: 4,
        // One entry per path, keyed query-less (see stripSearchFromCacheKey):
        // a chart opened from a setlist loads /charts/<id>?setlist=<id>, but
        // warming caches the query-less /charts/<id> — they must be the SAME
        // cache slot, or an old query-full entry would permanently shadow
        // every later re-warm (Cache API matching is insertion-ordered).
        // ignoreSearch stays as belt-and-suspenders for entries cached before
        // key normalization shipped.
        plugins: [stripSearchFromCacheKey],
        matchOptions: { ignoreSearch: true },
      }),
    },
    ...defaultCache,
  ],
});

serwist.addEventListeners();

// The runtime cache was renamed setlist-pages -> charts-pages when the section
// became "Charts". Serwist only cleans its own precache, so drop the old
// runtime cache on activate to avoid stranding it (a one-time storage leak).
// Also purge any query-full entries cached before cache keys were normalized
// to the query-less URL: `?_rsc=` flight payloads (the old blank-page bug) and
// `?setlist=`/`?category=` document entries alike. Because Cache API matching
// is insertion-ordered, a legacy query-full entry inserted before its
// query-less sibling would shadow every fresh re-warm forever.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await caches.delete("setlist-pages");
      for (const name of ["charts-pages", "app-shell"]) {
        const cache = await caches.open(name);
        for (const req of await cache.keys()) {
          if (new URL(req.url).search !== "") await cache.delete(req);
        }
      }
    })(),
  );
});

// ── Web Push ────────────────────────────────────────────────────
self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload: { title: string; body: string; url?: string; icon?: string };
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "hub", body: event.data.text() };
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: payload.icon || "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: payload.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data as { url?: string })?.url || "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (clients) => {
        // Reuse an existing window if one is open — but navigate it to the
        // notification's URL so we land on the right page, not wherever the
        // user left the app.
        for (const client of clients) {
          if (client.url.startsWith(self.location.origin)) {
            try {
              await client.navigate(url);
            } catch {
              // navigate() can reject on cross-origin or detached clients; fall through to focus
            }
            return client.focus();
          }
        }
        return self.clients.openWindow(url);
      }),
  );
});
