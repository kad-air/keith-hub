"use client";

import { createContext, useContext, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { SCORES_TZ, TZ_COOKIE, normalizeTz } from "@/lib/hoops/scores/dates";

/**
 * The viewer's time zone, for the scores pages (owner, 2026-11-05: "I
 * travel"). The server renders in the zone it read from the TZ_COOKIE
 * (lib/hoops/scores/viewerTz.ts) and hands it down here, so a client
 * component formats tip times in exactly the zone the server did — no
 * hydration mismatch.
 *
 * On mount, and whenever the page comes back into view (a PWA left open on
 * a flight), the device's own zone is compared with that one. If they
 * differ the cookie is rewritten and the server tree refreshed once, so
 * "today", the 3 AM / noon cutoffs and the tip times all move to where the
 * viewer is. A first visit therefore renders once in Mountain, then in the
 * device's zone. If the cookie can't be written (blocked storage) nothing
 * refreshes and the page simply stays in Mountain.
 */
const TzContext = createContext<string>(SCORES_TZ);

export function useViewerTz(): string {
  return useContext(TzContext);
}

export function ViewerTzProvider({ tz, children }: { tz: string; children: React.ReactNode }) {
  const router = useRouter();
  const asked = useRef<string | null>(null);

  useEffect(() => {
    const check = () => {
      let device: string | null = null;
      try {
        device = normalizeTz(Intl.DateTimeFormat().resolvedOptions().timeZone);
      } catch {
        device = null;
      }
      if (!device || device === tz || asked.current === device) return;
      asked.current = device;
      try {
        document.cookie = `${TZ_COOKIE}=${encodeURIComponent(device)}; path=/; max-age=31536000; samesite=lax`;
      } catch {
        return;
      }
      if (document.cookie.includes(`${TZ_COOKIE}=${encodeURIComponent(device)}`)) router.refresh();
    };
    const onVis = () => {
      if (document.visibilityState === "visible") check();
    };
    check();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [tz, router]);

  return <TzContext.Provider value={tz}>{children}</TzContext.Provider>;
}
