"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-render the server page on an interval while something on it can still
 * change (a game in progress, tonight's slate). Only while the tab is visible,
 * and once on return to it — a backgrounded PWA shouldn't poll ESPN. The
 * server cache (lib/hoops/scores/data.ts) bounds the upstream rate no matter
 * how many tabs are open. Renders nothing.
 */
export default function LiveRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      timer = setInterval(() => router.refresh(), seconds * 1000);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVis = () => {
      if (document.visibilityState === "visible") {
        router.refresh();
        start();
      } else stop();
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [router, seconds]);
  return null;
}
