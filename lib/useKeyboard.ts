import { useEffect, useRef } from "react";

export type KeyHandler = (event: KeyboardEvent) => void;

export interface ShortcutMap {
  [key: string]: KeyHandler;
}

/**
 * Lightweight keyboard shortcut hook with single-key + chord (`g h`) support.
 *
 * Single-key shortcuts: keys are matched against `event.key` directly,
 * lowercased. So pass `"j"`, `"k"`, `"?"`, `"Enter"`, `"Escape"`, etc.
 *
 * Chord shortcuts: use a space-separated key like `"g h"`. After the user
 * presses the first key (`g`), the next key has 1.5s to land or the chord
 * is dropped.
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

    function clearChord() {
      chordPrefix = null;
      if (chordTimer) {
        clearTimeout(chordTimer);
        chordTimer = null;
      }
    }

    function onKeyDown(e: KeyboardEvent) {
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
      const isChordPrefix = Object.keys(map).some((k) =>
        k.startsWith(`${key} `)
      );
      if (isChordPrefix && !map[key]) {
        chordPrefix = key;
        chordTimer = setTimeout(clearChord, 1500);
        e.preventDefault();
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
