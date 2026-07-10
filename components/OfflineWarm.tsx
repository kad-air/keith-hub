"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

// Warms the service-worker cache for the Charts section from ANY page, so
// landing on the homepage with no signal can still get into Charts →
// Setlists → each offline setlist's charts. The per-page warmers
// (ChartsClient / SetlistDetailClient) only run when their pages are visited —
// a user who spends weeks in the Feed and then walks into a gig offline never
// triggered them, which left /charts uncached and tapping "Charts" blank.
// Mounted once in the root layout; renders nothing.

type OfflineSetlist = {
  id: string;
  updatedAt: string;
  charts: { id: string; updatedAt: string }[];
};

// Always warmed, regardless of setlist flags: the entry pages between the
// homepage and the charts. Both are small and cheap to re-fetch.
const ENTRY_PAGES = ["/charts", "/charts/setlists"];

export default function OfflineWarm() {
  const router = useRouter();
  const warmedRef = useRef("");
  const busyRef = useRef(false);
  // Bumped when a new SW takes control mid-warm: pages fetched before the
  // update may reference the OLD build, so the in-flight run must not record
  // its key as "warmed" — the next trigger re-fetches everything.
  const epochRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    // Ask the browser not to evict our caches under storage pressure — iOS
    // in particular reclaims "best effort" storage from PWAs that haven't
    // been opened in a while, which is exactly the weeks-of-Feed-use-then-
    // gig scenario the offline setlists exist for. Fire-and-forget: browsers
    // that refuse (or don't implement it) just stay best-effort.
    try {
      void navigator.storage?.persist?.();
    } catch {
      /* ignore */
    }

    async function warm() {
      if (busyRef.current) return;
      if (!navigator.onLine || !("serviceWorker" in navigator)) return;
      busyRef.current = true;
      const epoch = epochRef.current;
      try {
        // Warm fetches only populate the cache once the SW controls the page.
        // On first install the page isn't controlled yet — bail; clientsClaim
        // fires controllerchange, ServiceWorkerRegister reloads, and the
        // remount warms under SW control.
        await navigator.serviceWorker.ready;
        if (cancelled || !navigator.serviceWorker.controller) return;

        // Non-OK (e.g. 401 pre-auth on /login) still warms the public entry
        // pages; a thrown fetch means we're offline after all, so retry later.
        let setlists: OfflineSetlist[] = [];
        try {
          const res = await fetch("/api/setlists/offline");
          if (res.ok) {
            ({ setlists } = (await res.json()) as {
              setlists: OfflineSetlist[];
            });
          }
        } catch {
          return;
        }

        // Same key shape as ChartsClient's offlineKey: chart updatedAt is
        // folded in so an edit re-warms the page instead of serving a stale
        // render offline; the setlist's own updatedAt is folded in because
        // chart pages bake in setlist names + next-song pointers, so a
        // rename/reorder must re-warm member pages too.
        const key = setlists
          .map(
            (s) =>
              `${s.id}@${s.updatedAt}:${s.charts.map((c) => `${c.id}@${c.updatedAt}`).join("+")}`,
          )
          .join(",");
        if (cancelled || warmedRef.current === key) return;

        const pages = new Set<string>(ENTRY_PAGES);
        for (const s of setlists) {
          pages.add(`/charts/setlists/${s.id}`);
          for (const c of s.charts) pages.add(`/charts/${c.id}`);
        }
        for (const href of Array.from(pages)) {
          if (cancelled) return;
          try {
            await fetch(href);
            router.prefetch(href);
          } catch {
            // Lost the network mid-warm — leave the key unset so the next
            // online/visibility event retries the remaining pages.
            return;
          }
        }
        if (!cancelled && epoch === epochRef.current) warmedRef.current = key;
      } finally {
        busyRef.current = false;
      }
      // A SW update landed while this run was in flight — its fetches may
      // hold the old build. Go again immediately under the new epoch.
      if (!cancelled && epoch !== epochRef.current) warm();
    }

    // Re-check on PWA resume too: the setlists may have been edited from
    // another device while the app slept. The key guard makes an unchanged
    // resume cost one small API GET, nothing more.
    const onVisible = () => {
      if (document.visibilityState === "visible") warm();
    };

    // A new deploy's SW taking over (skipWaiting + clientsClaim) purges the
    // OLD build's precached chunks — cached HTML that references them would
    // hydrate dead if served offline. On charts pages ServiceWorkerRegister
    // deliberately does NOT reload on update (never yank a live chart), so
    // re-warm here instead: reset the key and re-fetch every page so the
    // cached HTML matches the new build's precache. Elsewhere the register
    // component reloads the page and the remount warms — this listener just
    // never gets the chance to matter there.
    const onControllerChange = () => {
      epochRef.current++;
      warmedRef.current = "";
      warm();
    };

    warm();
    window.addEventListener("online", warm);
    document.addEventListener("visibilitychange", onVisible);
    navigator.serviceWorker?.addEventListener(
      "controllerchange",
      onControllerChange,
    );
    return () => {
      cancelled = true;
      window.removeEventListener("online", warm);
      document.removeEventListener("visibilitychange", onVisible);
      navigator.serviceWorker?.removeEventListener(
        "controllerchange",
        onControllerChange,
      );
    };
  }, [router]);

  return null;
}
