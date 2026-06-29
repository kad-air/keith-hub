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
    // Setlist gets a dedicated NetworkFirst cache so chord charts stay
    // available offline — the use case is playing a gig with no signal.
    // Online (or within the 4s timeout) the network wins so edits show up
    // immediately; offline it falls back to the last-cached render of each
    // page. The chart text is baked into the SSR'd HTML and the viewer's
    // interactivity (autoscroll, zoom, wake-lock) is entirely client-side,
    // so a cached page is fully functional offline. The index warms every
    // chart page on load (see SetlistClient) so the WHOLE setlist is
    // offline-ready after one online visit — not just the charts you opened.
    // This must precede defaultCache so it wins the /setlist* routes.
    {
      matcher: ({ url, sameOrigin }) =>
        sameOrigin &&
        (url.pathname === "/setlist" || url.pathname.startsWith("/setlist/")),
      handler: new NetworkFirst({
        cacheName: "setlist-pages",
        networkTimeoutSeconds: 4,
      }),
    },
    ...defaultCache,
  ],
});

serwist.addEventListeners();

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
