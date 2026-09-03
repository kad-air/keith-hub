"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { teamName } from "@/lib/hoops/rating";

// The only client code the comparison needs: two <select>s that navigate.
// Everything else on /hoops/players/compare renders on the server, because
// the whole answer is a function of the two ids in the URL — which also makes
// every comparison a link somebody can send.

export interface PickOption {
  athlete_id: number;
  name: string;
  tri: string;
}

/** Whole-league options, grouped by team. Names come through untouched, so
 *  accents render as they arrive rather than being folded for display. */
function TeamGroups({ options }: { options: PickOption[] }) {
  const byTeam = new Map<string, PickOption[]>();
  for (const o of options) {
    const list = byTeam.get(o.tri) ?? [];
    list.push(o);
    byTeam.set(o.tri, list);
  }
  const tris = [...byTeam.keys()].sort();
  return (
    <>
      {tris.map((tri) => (
        <optgroup key={tri} label={`${tri} · ${teamName(tri)}`}>
          {(byTeam.get(tri) ?? [])
            .slice()
            .sort((x, y) => x.name.localeCompare(y.name))
            .map((o) => (
              <option key={o.athlete_id} value={String(o.athlete_id)}>
                {o.name}
              </option>
            ))}
        </optgroup>
      ))}
    </>
  );
}

const SELECT_CLASS =
  "w-full min-w-0 border border-rule/60 bg-ink px-2 py-2 font-mono text-[0.7rem] text-cream-dim transition-colors hover:border-cat-hoops/40";

/** The comparison page's own pickers: change either side, get a new answer. */
export default function ComparePickers({
  options,
  a,
  b,
}: {
  options: PickOption[];
  a: number | null;
  b: number | null;
}) {
  const router = useRouter();
  const go = useCallback(
    (next: { a?: string; b?: string }) => {
      const na = next.a ?? (a != null ? String(a) : "");
      const nb = next.b ?? (b != null ? String(b) : "");
      const params = new URLSearchParams();
      if (na) params.set("a", na);
      if (nb) params.set("b", nb);
      router.push(`/hoops/players/compare?${params.toString()}`);
    },
    [router, a, b],
  );
  return (
    <div className="grid grid-cols-2 gap-2">
      <label className="min-w-0">
        <span className="block font-mono text-[0.58rem] uppercase tracking-kicker text-cream-dimmer">
          First player
        </span>
        <select
          className={`mt-1 ${SELECT_CLASS}`}
          value={a != null ? String(a) : ""}
          onChange={(e) => go({ a: e.target.value })}
          aria-label="First player"
        >
          <option value="">Pick a player…</option>
          <TeamGroups options={options} />
        </select>
      </label>
      <label className="min-w-0">
        <span className="block font-mono text-[0.58rem] uppercase tracking-kicker text-cream-dimmer">
          Second player
        </span>
        <select
          className={`mt-1 ${SELECT_CLASS}`}
          value={b != null ? String(b) : ""}
          onChange={(e) => go({ b: e.target.value })}
          aria-label="Second player"
        >
          <option value="">Pick a player…</option>
          <TeamGroups options={options} />
        </select>
      </label>
    </div>
  );
}

/** The player page's one-select shortcut into the comparison. */
export function CompareWithPicker({
  options,
  self,
}: {
  options: PickOption[];
  /** The athlete whose page this is — he becomes the `a` side. */
  self: number;
}) {
  const router = useRouter();
  return (
    <label className="mt-3 block">
      <select
        className={SELECT_CLASS}
        value=""
        onChange={(e) => {
          if (e.target.value) router.push(`/hoops/players/compare?a=${self}&b=${e.target.value}`);
        }}
        aria-label="Compare with another player"
      >
        <option value="">Compare with…</option>
        <TeamGroups options={options.filter((o) => o.athlete_id !== self)} />
      </select>
    </label>
  );
}
