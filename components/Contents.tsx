"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SECTIONS, type Section, type SectionGroup } from "@/lib/sections";

const GROUP_ORDER: SectionGroup[] = [
  "Reading",
  "Tracking",
  "Library",
  "Guitar",
];

const SHORTCUT_HINTS = [
  ["g f", "Feed"],
  ["g s", "Saved"],
  ["g r", "Read"],
  ["?", "Shortcuts"],
  ["⌘ K", "Jump"],
  ["Esc", "Close"],
];

type Props = {
  open: boolean;
  onClose: () => void;
  currentKey: string;
};

export default function Contents({ open, onClose, currentKey }: Props) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  // Group sections
  const groups = useMemo(() => {
    return GROUP_ORDER.map((group) => ({
      group,
      items: SECTIONS.filter((s) => s.group === group),
    })).filter((g) => g.items.length > 0);
  }, []);

  // Filtered list (flat) for keyboard nav + matching
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SECTIONS;
    return SECTIONS.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.desc?.toLowerCase().includes(q),
    );
  }, [query]);

  // Focus input on open; clear query on close
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 60);
      return () => clearTimeout(t);
    } else {
      setQuery("");
    }
  }, [open]);

  // Lock body scroll while open
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Esc closes; Enter on filter jumps to first match
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter" && matches.length > 0) {
        e.preventDefault();
        router.push(matches[0].href);
        onClose();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, matches, onClose, router]);

  if (!open) return null;

  const visible = (s: Section) => matches.includes(s);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Contents"
      className="fixed inset-0 z-[60] overflow-y-auto bg-ink/95 backdrop-blur-xl animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="mx-auto max-w-[980px] px-[max(1.5rem,env(safe-area-inset-left))] pb-20 pt-[calc(env(safe-area-inset-top)+2.5rem)]">
        {/* Head */}
        <div className="flex items-baseline justify-between border-b border-rule pb-4">
          <div className="font-mono text-[0.7rem] uppercase tracking-[0.32em] text-cream-dim">
            <span className="mr-2.5 text-accent">§</span>Contents
          </div>
          <button
            type="button"
            onClick={onClose}
            className="border border-rule px-3 py-1.5 font-mono text-[0.6rem] uppercase tracking-[0.22em] text-cream-dim transition-colors hover:border-accent hover:text-cream"
          >
            Esc · Close
          </button>
        </div>

        {/* Search */}
        <div className="mt-7 flex items-center gap-3.5 border-b border-rule px-0 py-2">
          <span className="font-display text-[1.6rem] italic leading-none text-cream-dimmer">
            ⌕
          </span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to anything…"
            autoComplete="off"
            spellCheck={false}
            className="flex-1 bg-transparent font-display text-[1.4rem] leading-tight text-cream outline-none placeholder:italic placeholder:text-cream-dimmer sm:text-[1.6rem]"
          />
          <span className="hidden border border-rule px-2 py-1 font-mono text-[0.6rem] uppercase tracking-[0.22em] text-cream-dimmer sm:inline">
            ⌘ K
          </span>
        </div>

        {/* List */}
        <div className="mt-2">
          {groups.map(({ group, items }) => {
            const visibleItems = items.filter(visible);
            if (visibleItems.length === 0) return null;
            return (
              <div key={group} className="mt-9">
                <div className="mb-1 font-mono text-[0.6rem] uppercase tracking-[0.32em] text-cream-dimmer">
                  — {group}
                </div>
                {visibleItems.map((s) => (
                  <ContentsRow
                    key={s.key}
                    section={s}
                    isCurrent={s.key === currentKey}
                    onNavigate={onClose}
                  />
                ))}
              </div>
            );
          })}
        </div>

        {/* Footer chord legend */}
        <div className="mt-14 flex flex-wrap gap-x-7 gap-y-3 border-t border-rule pt-5 font-mono text-[0.6rem] uppercase tracking-[0.18em] text-cream-dimmer">
          {SHORTCUT_HINTS.map(([keys, label]) => (
            <span key={label} className="inline-flex items-center gap-1.5">
              {keys.split(" ").map((k) => (
                <kbd
                  key={k}
                  className="border border-rule-strong bg-ink-raised px-1.5 py-0.5 font-mono text-[0.58rem] text-cream-dim"
                >
                  {k}
                </kbd>
              ))}
              <span className="ml-1.5">{label}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function ContentsRow({
  section,
  isCurrent,
  onNavigate,
}: {
  section: Section;
  isCurrent: boolean;
  onNavigate: () => void;
}) {
  return (
    <Link
      href={section.href}
      onClick={onNavigate}
      className={[
        "group relative grid items-baseline gap-4 border-b border-rule py-4 sm:grid-cols-[56px_1fr_auto] sm:gap-6 sm:py-[18px]",
        "grid-cols-[36px_1fr]",
      ].join(" ")}
    >
      <span
        aria-hidden
        className={[
          "absolute -left-4 top-0 bottom-0 w-[2px] transition-colors",
          isCurrent ? "bg-accent" : "bg-transparent group-hover:bg-accent",
        ].join(" ")}
      />
      <span className="font-mono text-[0.7rem] uppercase tracking-[0.18em] text-cream-dimmer">
        {section.num}
      </span>
      <span
        className={[
          "font-display text-[1.55rem] font-medium leading-none -tracking-[0.012em] transition-colors sm:text-[2.2rem]",
          isCurrent ? "text-accent" : "text-cream",
        ].join(" ")}
      >
        {section.name}
        {section.flavor && (
          <span className="font-normal italic text-cream-dim"> {section.flavor}</span>
        )}
      </span>
      {section.desc && (
        <span className="hidden max-w-[260px] text-right font-mono text-[0.66rem] uppercase tracking-[0.16em] text-cream-dimmer sm:inline">
          {section.desc}
        </span>
      )}
    </Link>
  );
}
