"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme, type ThemeMode } from "@/components/ThemeProvider";

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function formatMergeDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function AppMenu() {
  const [open, setOpen] = useState(false);
  const { mode, setMode } = useTheme();
  const menuRef = useRef<HTMLDivElement>(null);
  const [pushState, setPushState] = useState<"loading" | "unsupported" | "denied" | "off" | "on">("loading");

  const commit = process.env.NEXT_PUBLIC_GIT_COMMIT || "dev";
  const mergeTs = process.env.NEXT_PUBLIC_GIT_LAST_MERGE_TS || "";

  // Check push notification state
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setPushState("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setPushState("denied");
      return;
    }
    // Check if we have an active subscription on the server
    fetch("/api/push/subscribe")
      .then((r) => r.json())
      .then((data: { subscribed: boolean }) => setPushState(data.subscribed ? "on" : "off"))
      .catch(() => setPushState("off"));
  }, []);

  const togglePush = async () => {
    if (pushState === "on") {
      // Unsubscribe
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
      await fetch("/api/push/subscribe", { method: "DELETE" });
      setPushState("off");
    } else {
      // Subscribe — permission prompt fires here (requires user gesture)
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setPushState("denied");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
      });
      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sub.toJSON()),
      });
      setPushState("on");
    }
  };

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="App menu"
        aria-expanded={open}
        className="flex h-8 w-8 items-center justify-center rounded-sm text-cream-dim transition-colors hover:text-cream [@media(hover:none)]:h-11 [@media(hover:none)]:w-11"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 z-50 w-56 border border-rule-strong bg-ink-raised shadow-2xl shadow-black/40 animate-fade-in">
          {/* Theme section */}
          <div className="px-4 pt-4 pb-3">
            <h3 className="mb-2.5 font-mono text-[0.68rem] uppercase tracking-kicker text-cream-dim">
              Appearance
            </h3>
            <div className="flex gap-1">
              {THEME_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setMode(opt.value)}
                  className={[
                    "flex-1 rounded-sm px-2 py-1.5 font-mono text-[0.7rem] uppercase tracking-kicker transition-colors",
                    mode === opt.value
                      ? "bg-accent-soft text-accent border border-accent/30"
                      : "text-cream-dim border border-rule hover:border-rule-strong hover:text-cream",
                  ].join(" ")}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Divider */}
          <div className="mx-4 h-px bg-rule" />

          {/* Notifications section */}
          {pushState !== "unsupported" && (
            <>
              <div className="px-4 py-3">
                <h3 className="mb-2.5 font-mono text-[0.68rem] uppercase tracking-kicker text-cream-dim">
                  Notifications
                </h3>
                {pushState === "denied" ? (
                  <p className="font-mono text-[0.7rem] text-cream-dim">
                    Blocked in system settings
                  </p>
                ) : (
                  <button
                    type="button"
                    onClick={togglePush}
                    disabled={pushState === "loading"}
                    className={[
                      "w-full rounded-sm px-2 py-1.5 font-mono text-[0.7rem] uppercase tracking-kicker transition-colors border",
                      pushState === "on"
                        ? "bg-accent-soft text-accent border-accent/30"
                        : "text-cream-dim border-rule hover:border-rule-strong hover:text-cream",
                    ].join(" ")}
                  >
                    {pushState === "loading"
                      ? "..."
                      : pushState === "on"
                        ? "Release alerts on"
                        : "Enable release alerts"}
                  </button>
                )}
              </div>
              <div className="mx-4 h-px bg-rule" />
            </>
          )}

          {/* Version section */}
          <div className="px-4 py-3">
            <h3 className="mb-2 font-mono text-[0.68rem] uppercase tracking-kicker text-cream-dim">
              Version
            </h3>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[0.68rem] uppercase tracking-kicker text-cream-dim">
                  Commit
                </span>
                <span className="font-mono text-[0.72rem] text-cream tabular-nums">
                  {commit}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="font-mono text-[0.68rem] uppercase tracking-kicker text-cream-dim">
                  Updated
                </span>
                <span className="font-mono text-[0.68rem] text-cream-dim tabular-nums">
                  {formatMergeDate(mergeTs)}
                </span>
              </div>
            </div>
          </div>

          {/* Divider */}
          <div className="mx-4 h-px bg-rule" />

          {/* Log out */}
          <div className="px-4 py-3">
            <form action="/api/auth/logout" method="POST">
              <button
                type="submit"
                className="w-full rounded-sm px-2 py-1.5 font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dim border border-rule transition-colors hover:border-rule-strong hover:text-cream"
              >
                Log out
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
