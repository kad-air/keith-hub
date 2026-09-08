import { useEffect, useRef } from "react";

export type KeyHandler = (event: KeyboardEvent) => void;

export interface ShortcutMap {
  [key: string]: KeyHandler;
}

/** How long a chord prefix (`g`) waits for its second key. */
export const CHORD_TIMEOUT_MS = 2500;

/**
 * Fired on `window` when a chord prefix is pressed (`detail.prefix` set) and
 * again when it resolves or times out (`detail.prefix` null). The Masthead's
 * ChordHint listens and shows what can be pressed next.
 */
export const CHORD_EVENT = "hub:chord";
export type ChordEventDetail = { prefix: string | null; keys: string[] };

/**
 * Lightweight keyboard shortcut hook with single-key + chord (`g h`) support.
 *
 * Single-key shortcuts: keys are matched against `event.key` directly,
 * lowercased. So pass `"j"`, `"k"`, `"?"`, `"Enter"`, `"Escape"`, etc.
 *
 * Chord shortcuts: use a space-separated key like `"g h"`. After the user
 * presses the first key (`g`), the next key has `CHORD_TIMEOUT_MS` to land or
 * the chord is dropped. The pending prefix is announced on `window` as
 * `CHORD_EVENT` so the UI can show what can be pressed next.
 *
 * The hook ignores key events while the user is typing in an input/textarea
 * or has any modifier key (cmd/ctrl/alt) pressed, so browser shortcuts and
 * URL bars stay sacred.
 */
export function useKeyboard(shortcuts: ShortcutMap, enabled = true): void {
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;

  useEffect(() => {
    if (!enabled) return;

    let chordPrefix: string | null = null;
    let chordTimer: ReturnType<typeof setTimeout> | null = null;

    function announce(prefix: string | null, keys: string[] = []) {
      window.dispatchEvent(
        new CustomEvent<ChordEventDetail>(CHORD_EVENT, { detail: { prefix, keys } }),
      );
    }

    function clearChord() {
      const had = chordPrefix !== null;
      chordPrefix = null;
      if (chordTimer) {
        clearTimeout(chordTimer);
        chordTimer = null;
      }
      if (had) announce(null);
    }

    function onKeyDown(e: KeyboardEvent) {
      // An overlay (Contents, the keyboard help) owns the keyboard while it
      // is open. It flags the root element rather than threading a context
      // through every client, since Masthead and the page are siblings.
      if (document.documentElement.hasAttribute("data-kb-modal")) return;
      // Don't intercept while typing
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          target.isContentEditable
        ) {
          return;
        }
      }
      // Don't intercept browser/system shortcuts
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // Lowercase everything: "Enter" -> "enter", "Escape" -> "escape", "?" -> "?"
      const key = e.key.toLowerCase();
      const map = shortcutsRef.current;

      if (chordPrefix) {
        const chordKey = `${chordPrefix} ${key}`;
        clearChord();
        const handler = map[chordKey];
        if (handler) {
          e.preventDefault();
          handler(e);
        }
        return;
      }

      // Is the key the start of a chord?
      const chordKeys = Object.keys(map)
        .filter((k) => k.startsWith(`${key} `))
        .map((k) => k.slice(key.length + 1));
      if (chordKeys.length > 0 && !map[key]) {
        chordPrefix = key;
        chordTimer = setTimeout(clearChord, CHORD_TIMEOUT_MS);
        e.preventDefault();
        announce(key, chordKeys);
        return;
      }

      const handler = map[key];
      if (handler) {
        e.preventDefault();
        handler(e);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      clearChord();
    };
  }, [enabled]);
}
