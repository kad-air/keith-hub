"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useKeyboard, type ShortcutMap } from "@/lib/useKeyboard";
import { SECTIONS, getCurrentSection } from "@/lib/sections";
import { adjacentSection } from "@/lib/shortcuts";

export const HELP_EVENT = "hub:keyboard-help";

/** Any page can ask for the help overlay (the end-of-feed "Keyboard" button). */
export function requestKeyboardHelp(): void {
  window.dispatchEvent(new CustomEvent(HELP_EVENT));
}

const ITEM_SELECTOR = "[data-kb-item]";
const SEARCH_SELECTOR = "[data-kb-search]";

function visibleItems(): HTMLElement[] {
  const root = document.querySelector("main") ?? document.body;
  return Array.from(root.querySelectorAll<HTMLElement>(ITEM_SELECTOR)).filter(
    // offsetParent is null for display:none subtrees (a collapsed pane, a
    // filtered-out row); position:fixed rows don't occur in these lists.
    (el) => el.offsetParent !== null && !el.hasAttribute("disabled"),
  );
}

function focusItem(el: HTMLElement) {
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/**
 * Roving focus over `[data-kb-item]` rows. When nothing in the list is
 * focused, `j` starts at the first row that is at or below the top of the
 * viewport (so a scrolled page starts where you are looking) and `k` at the
 * last row above it.
 */
function move(dir: 1 | -1) {
  const items = visibleItems();
  if (items.length === 0) return;
  const active = document.activeElement as HTMLElement | null;
  const i = active ? items.indexOf(active) : -1;
  if (i >= 0) {
    const next = items[Math.min(items.length - 1, Math.max(0, i + dir))];
    focusItem(next);
    return;
  }
  const top = Math.max(0, (document.querySelector("header")?.getBoundingClientRect().bottom ?? 0));
  const firstBelow = items.findIndex((el) => el.getBoundingClientRect().top >= top);
  if (dir === 1) {
    focusItem(items[firstBelow < 0 ? items.length - 1 : firstBelow]);
  } else {
    const idx = firstBelow < 0 ? items.length - 1 : Math.max(0, firstBelow - 1);
    focusItem(items[idx]);
  }
}

type Props = {
  /** Open Contents (the section picker). */
  onContents: () => void;
  /** Toggle the keyboard help overlay. */
  onHelp: () => void;
  /** Bindings pause while an overlay owns the keyboard. */
  enabled: boolean;
};

/**
 * The hub-wide keyboard layer — mounted once by the Masthead so it is live
 * on every route. Section clients keep their own bindings (Feed's triage
 * keys, the chart viewer's transport) and never need to re-declare these.
 *
 * Feed / Saved / Read own `j` / `k` / `o` themselves over their card list;
 * their cards carry no `data-kb-item`, so the roving handler here finds no
 * rows and stays out of the way on those routes.
 */
export default function GlobalKeys({ onContents, onHelp, enabled }: Props) {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    const handler = () => onHelp();
    window.addEventListener(HELP_EVENT, handler);
    return () => window.removeEventListener(HELP_EVENT, handler);
  }, [onHelp]);

  const map: ShortcutMap = {
    "?": onHelp,
    "g g": onContents,
    "]": () => router.push(adjacentSection(getCurrentSection(pathname), 1).href),
    "[": () => router.push(adjacentSection(getCurrentSection(pathname), -1).href),
    "/": () => {
      const input = document.querySelector<HTMLInputElement>(SEARCH_SELECTOR);
      if (input) {
        input.focus();
        input.select();
      } else {
        onContents();
      }
    },
    j: () => move(1),
    k: () => move(-1),
    o: () => {
      const active = document.activeElement as HTMLElement | null;
      if (active?.matches(ITEM_SELECTOR)) active.click();
    },
  };
  for (const s of SECTIONS) {
    if (s.hotkey) map[`g ${s.hotkey}`] = () => router.push(s.href);
  }

  useKeyboard(map, enabled);
  return null;
}
