"use client";

import { useEffect } from "react";

export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    // Was this page load already under SW control? Distinguishes the FIRST
    // install (controller: null -> SW; the reload is required so warming
    // fetches actually populate the caches) from an UPDATE (a new deploy's
    // SW taking over via skipWaiting + clientsClaim).
    const hadController = !!navigator.serviceWorker.controller;

    let refreshing = false;
    const onControllerChange = () => {
      if (refreshing) return;
      // On UPDATE, never yank a charts page out from under the user — a
      // deploy landing mid-song at a gig must not reload a live chart
      // (scroll position, autoscroll, and the wake lock all die with the
      // page). OfflineWarm listens for the same controllerchange and
      // re-warms the offline caches against the new build instead; the page
      // picks the new bundle up on its next natural navigation.
      if (hadController && window.location.pathname.startsWith("/charts")) {
        return;
      }
      refreshing = true;
      window.location.reload();
    };

    navigator.serviceWorker.addEventListener(
      "controllerchange",
      onControllerChange
    );

    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .catch((err) => {
        console.error("[SW] Registration failed:", err);
      });

    return () => {
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        onControllerChange
      );
    };
  }, []);

  return null;
}
