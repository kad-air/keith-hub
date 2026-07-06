/// <reference lib="webworker" />
import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { NetworkFirst, Serwist } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    // Injected by @serwist/next at build time.
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
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
        // Match ignoring the query string: a chart opened from a setlist links
        // to /charts/<id>?setlist=<id>, but warming caches the query-less
        // /charts/<id>. Without this, the offline navigation (query-full) would
        // miss the warmed (query-less) entry — breaking the exact gig-with-no-
        // signal flow this cache exists for.
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
// Also purge any `?_rsc=` flight entries cached before the charts rule
// excluded RSC requests — with ignoreSearch matching they could still be
// returned for an offline document load (the blank-page bug).
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await caches.delete("setlist-pages");
      const cache = await caches.open("charts-pages");
      for (const req of await cache.keys()) {
        if (new URL(req.url).searchParams.has("_rsc")) await cache.delete(req);
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
