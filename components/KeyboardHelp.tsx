"use client";

import { useEffect } from "react";

interface KeyboardHelpProps {
  open: boolean;
  onClose: () => void;
}

const SHORTCUTS: Array<{
  section: string;
  rows: Array<{ keys: string[]; label: string }>;
}> = [
  {
    section: "Navigate",
    rows: [
      { keys: ["j"], label: "Next item" },
      { keys: ["k"], label: "Previous item" },
      { keys: ["g", "h"], label: "Go home" },
      { keys: ["g", "s"], label: "Go to saved" },
      { keys: ["g", "r"], label: "Go to read" },
    ],
  },
  {
    section: "Triage",
    rows: [
      { keys: ["o"], label: "Open in new tab" },
      { keys: ["enter"], label: "Open in new tab" },
      { keys: ["s"], label: "Save / unsave" },
      { keys: ["x"], label: "Dismiss" },
      { keys: ["e"], label: "Dismiss" },
      { keys: ["c"], label: "Clear this item and all above" },
    ],
  },
  {
    section: "Other",
    rows: [
      { keys: ["r"], label: "Refresh feeds" },
      { keys: ["?"], label: "Toggle this help" },
      { keys: ["esc"], label: "Close this help" },
    ],
  },
];

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded-sm border border-rule-strong bg-ink px-1.5 font-mono text-[0.75rem] uppercase text-cream">
      {children}
    </kbd>
  );
}

export default function KeyboardHelp({ open, onClose }: KeyboardHelpProps) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" || e.key === "?") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/85 px-6 backdrop-blur-sm animate-fade-in"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-md border border-rule-strong bg-ink-raised px-8 py-7 shadow-2xl shadow-black/60"
      >
        <div className="mb-5 flex items-baseline justify-between border-b border-rule pb-3">
          <h2 className="font-display text-[1.5rem] font-medium italic text-cream">
            Keyboard
          </h2>
          <span className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dim">
            press ? to toggle
          </span>
        </div>
        <div className="space-y-5">
          {SHORTCUTS.map((section) => (
            <div key={section.section}>
              <h3 className="mb-2 font-mono text-[0.72rem] uppercase tracking-kicker text-cat-film">
                {section.section}
              </h3>
              <ul className="space-y-1.5">
                {section.rows.map((row) => (
                  <li
                    key={row.label + row.keys.join("-")}
                    className="flex items-center justify-between gap-4"
                  >
                    <span className="font-display text-[1rem] text-cream">
                      {row.label}
                    </span>
                    <span className="flex items-center gap-1">
                      {row.keys.map((k, i) => (
                        <span key={i} className="flex items-center gap-1">
                          {i > 0 && (
                            <span className="text-cream-dimmer">then</span>
                          )}
                          <Kbd>{k}</Kbd>
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
