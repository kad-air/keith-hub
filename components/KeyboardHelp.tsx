"use client";

import { useEffect } from "react";
import { getCurrentSection } from "@/lib/sections";
import {
  GLOBAL_SHORTCUTS,
  getSectionShortcuts,
  sectionJumpRows,
  type ShortcutGroup,
} from "@/lib/shortcuts";

interface KeyboardHelpProps {
  open: boolean;
  onClose: () => void;
  /** The route the overlay opened on — picks the "this section" rows. */
  pathname: string;
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded-sm border border-rule-strong bg-ink px-1.5 font-mono text-[0.75rem] uppercase text-cream">
      {children}
    </kbd>
  );
}

function Group({ group }: { group: ShortcutGroup }) {
  return (
    <div>
      <h3 className="mb-2 font-mono text-[0.72rem] uppercase tracking-kicker text-cat-film">
        {group.section}
      </h3>
      <ul className="space-y-1.5">
        {group.rows.map((row) => (
          <li
            key={row.label + row.keys.join("-")}
            className="flex items-center justify-between gap-4"
          >
            <span className="font-display text-[1rem] text-cream">{row.label}</span>
            <span className="flex items-center gap-1">
              {row.keys.map((k, i) => (
                <span key={i} className="flex items-center gap-1">
                  {i > 0 && <span className="text-cream-dimmer">then</span>}
                  <Kbd>{k}</Kbd>
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The `?` overlay. One instance, mounted by the Masthead, so it reads the
 * same on every route: the section you're in first, then the section jumps,
 * then what works everywhere. `lib/shortcuts.ts` is the source of truth for
 * every row here.
 */
export default function KeyboardHelp({ open, onClose, pathname }: KeyboardHelpProps) {
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

  const section = getCurrentSection(pathname);
  const local = getSectionShortcuts(section);
  const jump: ShortcutGroup = { section: "Go to", rows: sectionJumpRows() };
  const left: ShortcutGroup[] = [...local, ...GLOBAL_SHORTCUTS];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      onClick={onClose}
      className="fixed inset-0 z-[70] flex items-center justify-center overflow-y-auto bg-ink/85 px-6 py-8 backdrop-blur-sm animate-fade-in"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative my-auto w-full max-w-2xl border border-rule-strong bg-ink-raised px-8 py-7 shadow-2xl shadow-black/60"
      >
        <div className="mb-5 flex items-baseline justify-between border-b border-rule pb-3">
          <h2 className="font-display text-[1.5rem] font-medium italic text-cream">
            Keyboard
            <span className="ml-3 font-normal not-italic text-cream-dim">{section.name}</span>
          </h2>
          <span className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dim">
            press ? to toggle
          </span>
        </div>
        <div className="grid gap-x-10 gap-y-5 sm:grid-cols-2">
          <div className="space-y-5">
            {left.map((g) => (
              <Group key={g.section} group={g} />
            ))}
          </div>
          <div>
            <Group group={jump} />
            <p className="mt-4 font-mono text-[0.66rem] uppercase tracking-kicker text-cream-dimmer">
              Number keys switch a section&apos;s tabs · j / k walk any list · Enter opens
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
