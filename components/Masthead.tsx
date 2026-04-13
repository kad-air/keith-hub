"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import AppMenu from "@/components/AppMenu";
import Contents from "@/components/Contents";
import SubBar from "@/components/SubBar";
import { getCurrentSection } from "@/lib/sections";

export default function Masthead() {
  const pathname = usePathname();
  const section = getCurrentSection(pathname);
  const [open, setOpen] = useState(false);

  const close = useCallback(() => setOpen(false), []);

  // ⌘K / Ctrl+K opens the Contents overlay globally
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName;
        const typing =
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          (target?.isContentEditable ?? false);
        if (typing && !open) return;
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Close the overlay whenever the route changes
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-rule/60 bg-ink/95 pt-[env(safe-area-inset-top)] backdrop-blur-xl">
        <div className="mx-auto grid min-h-14 max-w-[1100px] grid-cols-[1fr_auto_1fr] items-baseline gap-3 px-[max(1rem,env(safe-area-inset-left))] py-2.5 sm:grid-cols-[1fr_auto_1fr] sm:gap-6 sm:px-[max(1.5rem,env(safe-area-inset-left))] sm:py-3.5">
          {/* Wordmark */}
          <Link href="/" className="justify-self-start">
            <span className="font-display text-[0.85rem] font-medium uppercase leading-none tracking-[0.24em] text-cream transition-colors hover:text-accent sm:text-[1.05rem] sm:tracking-[0.32em]">
              Hub<span className="text-accent">.</span>
            </span>
          </Link>

          {/* Section switch */}
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls="hub-contents"
            className="group inline-flex items-baseline gap-2 border-b border-rule px-2 py-1 font-display italic text-cream transition-colors hover:border-accent sm:gap-2.5 sm:px-3.5 sm:py-1.5"
          >
            <span className="hidden font-mono text-[0.6rem] not-italic uppercase tracking-[0.18em] text-cream-dimmer sm:inline -translate-y-[2px]">
              {section.num}
            </span>
            <span className="text-[1.05rem] font-normal leading-none sm:text-[1.35rem]">
              {section.name}
            </span>
            <span
              aria-hidden
              className="text-[0.75rem] not-italic leading-none text-cream-dim transition-colors group-hover:text-accent"
            >
              ⌄
            </span>
          </button>

          {/* Gear menu */}
          <div className="justify-self-end">
            <AppMenu />
          </div>
        </div>

        <SubBar />
      </header>

      <Contents open={open} onClose={close} currentKey={section.key} />
    </>
  );
}
