"use client";

import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type InputHTMLAttributes,
  type Ref,
} from "react";
import {
  BOUGHT,
  CORE_PEOPLE,
  FAMILY,
  STATUSES,
  familySplit,
  isCore,
  isFamily,
  personTotals,
  key,
  money,
  num,
  slug,
  type Gift,
  type ListState,
  type Person,
  type Totals,
} from "@/lib/christmas/shared";

// The shared Christmas gift list (/christmas). First built as a Claude
// artifact; ported here so the whole family can use it from a phone:
//   • storage: /api/christmas/* over the hub's SQLite (lib/christmas/store.ts).
//     Paths keep the artifact's doc names ("gifts/<id>", "people/<id>",
//     "config/main").
//   • live updates: a poll every few seconds that asks "has anything changed
//     since rev N?". Writes show at once (applied locally first); a poll never
//     lands while a write is still in flight, and a field being typed in keeps
//     its draft whatever arrives (Field, below).
//   • the helper lives on its own tab (/christmas/helper) and changes the list
//     on the server; its edits arrive here like the other parent's.

type Data = { people: Person[]; gifts: Gift[]; total: number | null; rev: number };
/** core: one of the six · family: the shared Family gifts · other: anyone added by hand, or a gift-only recipient. */
type Group = { name: string; person: Person | null; gifts: Gift[]; kind: "core" | "family" | "other" };

const POLL_MS = 3000;

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function urlOf(path: string): string {
  if (path === "config/main") return "/api/christmas/config";
  const [kind, id] = path.split("/");
  return `/api/christmas/${kind}/${encodeURIComponent(id)}`;
}

class ApiError extends Error {
  constructor(public code: string, public status: number) {
    super(code);
  }
}

/**
 * An input that never has its text replaced while someone is typing in it.
 * While focused it shows a local draft; on blur (or Enter) it commits — only
 * if the text changed since focus, like the original's `change` event — and
 * goes back to showing the shared value.
 */
function Field({
  value,
  onCommit,
  inputRef,
  ...rest
}: { value: string; onCommit: (v: string) => void; inputRef?: Ref<HTMLInputElement> } & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange"
>) {
  const [draft, setDraft] = useState<string | null>(null);
  const start = useRef("");
  return (
    <input
      {...rest}
      ref={inputRef}
      value={draft ?? value}
      onFocus={() => {
        start.current = value;
        setDraft(value);
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const d = draft;
        setDraft(null);
        if (d != null && d !== start.current) onCommit(d);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}

export default function ChristmasClient({ initial }: { initial: ListState }) {
  const D = useRef<Data>({ people: initial.people, gifts: initial.gifts, total: initial.totalBudget, rev: initial.rev });
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [focusNext, setFocusNext] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 3500);
  }, []);

  const signedOut = useCallback(() => {
    setBanner("You've been signed out of this list. Reload the page to enter the passcode again.");
  }, []);

  /* ---------- local copy ---------- */
  function setLocal(path: string, data: Record<string, unknown> | null) {
    const d = D.current;
    if (path === "config/main") {
      d.total = data ? num(data.totalBudget) : null;
      return;
    }
    const [kind, id] = path.split("/");
    if (kind === "gifts") {
      const rest = d.gifts.filter((g) => g.id !== id);
      d.gifts = data ? [...rest, { ...(data as unknown as Gift), id }] : rest;
    } else {
      const rest = d.people.filter((p) => p.id !== id);
      d.people = data ? [...rest, { ...(data as unknown as Person), id }] : rest;
    }
  }
  function patchLocal(path: string, patch: Record<string, unknown>) {
    const [kind, id] = path.split("/");
    if (kind === "gifts") D.current.gifts = D.current.gifts.map((g) => (g.id === id ? { ...g, ...patch } : g));
    else D.current.people = D.current.people.map((p) => (p.id === id ? { ...p, ...patch } : p));
  }

  /* ---------- writes (one at a time per document) ---------- */
  const q = useRef<Record<string, Promise<unknown>>>({});
  const inflight = useRef(0);
  const epoch = useRef(0);
  const pollRef = useRef<() => void>(() => {});

  async function api(method: string, url: string, body?: unknown): Promise<unknown> {
    const r = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
    if (r.status === 401) {
      signedOut();
      throw new ApiError("session_expired", 401);
    }
    const j = (await r.json().catch(() => ({}))) as { error?: { code?: string } };
    if (!r.ok) throw new ApiError(j.error?.code || "server_error", r.status);
    return j;
  }

  function write(path: string, local: () => void, send: () => Promise<unknown>): Promise<unknown> {
    local();
    rerender();
    inflight.current++;
    epoch.current++;
    const p = (q.current[path] || Promise.resolve())
      .then(send)
      .catch((e) => {
        if (!(e instanceof ApiError && e.status === 401)) toast("Couldn't save that change. Try again.");
        throw e;
      })
      .finally(() => {
        inflight.current--;
        // Settle on the server's copy (it sanitises, and the other parent may
        // have written in between).
        if (inflight.current === 0) pollRef.current();
      });
    q.current[path] = p.catch(() => {});
    return p;
  }

  const docSet = (path: string, data: Record<string, unknown>) =>
    write(path, () => setLocal(path, data), () => api("PUT", urlOf(path), data));
  const docDel = (path: string) => write(path, () => setLocal(path, null), () => api("DELETE", urlOf(path)));
  const docUpd = (path: string, patch: Record<string, unknown>) =>
    write(path, () => patchLocal(path, patch), () => api("PATCH", urlOf(path), patch));

  const updGift = (id: string, patch: Record<string, unknown>) => docUpd("gifts/" + id, patch);
  function newGift(data: Partial<Gift>): [string, Promise<unknown>] {
    const id = newId();
    const body = Object.assign(
      { recipient: "", group: "", idea: "", from: "", est: null, actual: null, status: "Idea", notes: "", createdAt: Date.now() },
      data,
    );
    return [id, docSet("gifts/" + id, body)];
  }
  const setPerson = (id: string, data: Record<string, unknown>) => docSet("people/" + id, data);
  const setTotal = (n: number | null) => docSet("config/main", { totalBudget: n });

  /* ---------- live updates ---------- */
  useEffect(() => {
    let polling = false;
    let again = false;
    let stopped = false;
    async function poll() {
      if (stopped) return;
      if (inflight.current > 0) return;
      if (polling) {
        again = true;
        return;
      }
      polling = true;
      const e = epoch.current;
      try {
        const r = await fetch(`/api/christmas?since=${D.current.rev}`, { cache: "no-store" });
        if (r.status === 401) {
          signedOut();
          return;
        }
        if (!r.ok) return;
        const j = (await r.json()) as ListState & { unchanged?: boolean };
        if (inflight.current > 0 || e !== epoch.current) {
          again = true;
          return;
        }
        if (j.unchanged) return;
        D.current = { people: j.people, gifts: j.gifts, total: j.totalBudget, rev: j.rev };
        rerender();
      } catch {
        /* offline for a moment — the next tick tries again */
      } finally {
        polling = false;
        if (again) {
          again = false;
          setTimeout(poll, 50);
        }
      }
    }
    pollRef.current = () => {
      // A write's own response can't be trusted to carry the latest rev (the
      // other parent may have written in between), so force a full read.
      D.current.rev = -1;
      void poll();
    };
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void poll();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [signedOut]);

  /* ---------- derived ---------- */
  function model() {
    const people = D.current.people.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    const gifts = D.current.gifts.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    // The six first, then the Family gifts they share, then everyone added by
    // hand, then any recipient that only has gifts.
    const groups = new Map<string, Group>();
    for (const p of people.filter((p) => isCore(p.id))) groups.set(key(p.name), { name: p.name, person: p, gifts: [], kind: "core" });
    groups.set(key(FAMILY), { name: FAMILY, person: null, gifts: [], kind: "family" });
    for (const p of people.filter((p) => !isCore(p.id))) {
      if (!groups.has(key(p.name))) groups.set(key(p.name), { name: p.name, person: p, gifts: [], kind: "other" });
    }
    for (const g of gifts) {
      const k = key(g.recipient) || "(unassigned)";
      if (!groups.has(k)) groups.set(k, { name: g.recipient || "Unassigned", person: null, gifts: [], kind: "other" });
      groups.get(k)!.gifts.push(g);
    }
    let est = 0, spent = 0, bought = 0;
    for (const g of gifts) {
      est += num(g.est) || 0;
      spent += num(g.actual) || 0;
      if (BOUGHT.has(g.status)) bought++;
    }
    const totals = personTotals(people, gifts);
    const fam = familySplit(gifts);
    return { people, gifts, groups: [...groups.values()], est, spent, bought, totals, fam };
  }
  const nextOrder = () => D.current.people.reduce((m, p) => Math.max(m, p.order || 0), 0) + 1;
  function uniqueId(name: string) {
    let id = slug(name), n = 2;
    const ids = new Set(D.current.people.map((p) => p.id));
    while (ids.has(id)) id = slug(name) + "-" + n++;
    return id;
  }

  function armConfirm(ck: string) {
    setConfirm(ck);
    setTimeout(() => setConfirm((c) => (c === ck ? null : c)), 4000);
  }

  /* ---------- render ---------- */
  const m = model();
  const total = D.current.total;
  const alloc = m.people.reduce((s, p) => s + (num(p.budget) || 0), 0);
  const unplanned = total != null ? total - m.est : null;
  const rem = total != null ? total - m.spent : null;
  const newName = useRef<HTMLInputElement>(null);

  function addPerson(e: React.FormEvent) {
    e.preventDefault();
    const el = newName.current;
    const name = (el?.value || "").trim();
    if (!name || !el) return;
    if (isFamily(name)) {
      toast("Family is already on the list — its gifts are split across the six of you.");
      return;
    }
    if (m.groups.some((G) => key(G.name) === key(name) && G.person)) {
      toast(name + " is already on the list.");
      return;
    }
    el.value = "";
    setPerson(uniqueId(name), { name, role: "", budget: null, order: nextOrder() }).catch(() => {});
  }

  const isNewGift = (id: string) => focusNext === "g:" + id + ":idea";

  return (
    <>
      {banner && (
        <p className="mb-4 border border-accent/50 px-3 py-2 font-mono text-[0.7rem] text-accent">{banner}</p>
      )}

      {/* The four numbers, one ledger strip. */}
      <div className="grid grid-cols-2 gap-px overflow-hidden border border-rule/60 bg-rule/60 sm:grid-cols-4">
        <Tile label="Total budget" sub={`${money(alloc)} assigned to people`}>
          <Field
            className="w-full min-w-0 border-b border-dashed border-rule bg-transparent p-0 font-display text-[1.65rem] leading-tight tabular-nums text-cream placeholder:text-cream-dimmer focus:border-accent focus:outline-none"
            inputMode="decimal"
            aria-label="Total budget"
            placeholder="Set budget"
            value={total == null ? "" : money(total)}
            onCommit={(v) => setTotal(num(v)).catch(() => {})}
          />
        </Tile>
        <Tile
          label="Estimated"
          value={money(m.est)}
          sub={unplanned == null ? " " : unplanned >= 0 ? `${money(unplanned)} not yet planned` : `${money(-unplanned)} over budget`}
          subNeg={unplanned != null && unplanned < 0}
        />
        <Tile label="Remaining" value={rem == null ? "—" : money(rem)} neg={rem != null && rem < 0} sub={`${money(m.spent)} spent so far`} />
        <Tile
          label="Wrapped up"
          value={
            <>
              {m.bought}
              <span className="text-cream-dimmer"> / {m.gifts.length}</span>
            </>
          }
          sub={`gift${m.gifts.length === 1 ? "" : "s"} bought`}
        />
      </div>

      <div className="mt-6 space-y-4">
        {!m.groups.length && (
          <p className="border border-dashed border-rule px-4 py-8 text-center font-display italic text-cream-dim">
            No one on the list yet. Add someone below, or ask the helper to set things up.
          </p>
        )}
        {m.groups.map((G) => (
          <RecipientSection
            key={G.person ? "p:" + G.person.id : "n:" + key(G.name)}
            G={G}
            totals={G.person ? m.totals.get(G.person.id) ?? null : null}
            fam={m.fam}
            confirm={confirm}
            isNew={isNewGift}
            onFocused={() => setFocusNext(null)}
            onBudget={(v) => {
              const b = num(v);
              if (G.person) docUpd("people/" + G.person.id, { budget: b }).catch(() => {});
              else if (b != null) setPerson(uniqueId(G.name), { name: G.name, role: "", budget: b, order: nextOrder() }).catch(() => {});
            }}
            onAddGift={() => {
              const [id, saved] = newGift({ recipient: G.name });
              setFocusNext("g:" + id + ":idea");
              saved.catch(() => {});
            }}
            onRemovePerson={() => {
              const p = G.person!;
              if (isCore(p.id)) return;
              const ck = "rm:" + p.id;
              if (confirm === ck) {
                setConfirm(null);
                docDel("people/" + p.id).catch(() => {});
              } else armConfirm(ck);
            }}
            onGift={(g, patch) => updGift(g.id, patch).catch(() => {})}
            onDeleteGift={(g) => {
              const ck = "del:" + g.id;
              if (confirm === ck) {
                setConfirm(null);
                docDel("gifts/" + g.id).catch(() => {});
              } else armConfirm(ck);
            }}
          />
        ))}

        <form className="flex items-end gap-3 pt-2" onSubmit={addPerson}>
          <input
            ref={newName}
            className="min-w-0 flex-1 border-b border-rule bg-transparent px-1 py-2 font-display text-[1.05rem] text-cream placeholder:italic placeholder:text-cream-dimmer focus:border-accent focus:outline-none"
            placeholder="Add someone — Grandma, the teachers…"
            aria-label="New recipient name"
            maxLength={60}
          />
          <button
            type="submit"
            className="shrink-0 border border-rule/60 px-3 py-2 font-mono text-[0.68rem] uppercase tracking-kicker text-cream-dim transition-colors hover:border-cat-xmas/60 hover:text-cat-xmas"
          >
            Add
          </button>
        </form>
      </div>

      {toastMsg && (
        <div className="fixed bottom-[calc(1.5rem+env(safe-area-inset-bottom))] left-1/2 z-40 max-w-[calc(100%-2rem)] -translate-x-1/2 border border-rule bg-ink-raised px-4 py-2 font-mono text-[0.7rem] text-cream shadow-lg lg:left-[calc(50%+6.5rem)]">
          {toastMsg}
        </div>
      )}
    </>
  );
}

function Tile({
  label,
  value,
  sub,
  neg,
  subNeg,
  children,
}: {
  label: string;
  value?: React.ReactNode;
  sub: string;
  neg?: boolean;
  subNeg?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="min-w-0 bg-ink px-4 py-3">
      <div className="font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dimmer">{label}</div>
      <div className={`mt-1 font-display text-[1.65rem] leading-tight tabular-nums ${neg ? "text-accent" : "text-cream"}`}>
        {children ?? value}
      </div>
      <div className={`mt-0.5 font-mono text-[0.62rem] leading-snug ${subNeg ? "text-accent" : "text-cream-dim"}`}>{sub}</div>
    </div>
  );
}

const STATUS_STYLE: Record<string, string> = {
  Idea: "border-cat-xmas-gold/50 text-cat-xmas-gold",
  Planned: "border-rule-strong text-cream-dim",
  Ordered: "border-rule-strong text-cream",
  Purchased: "border-cat-xmas/60 text-cat-xmas",
  Wrapped: "border-accent/60 bg-accent/10 text-accent",
};

const INPUT =
  "w-full min-w-0 border-b border-transparent bg-transparent px-1 py-1 text-cream placeholder:text-cream-dimmer/70 hover:border-rule focus:border-accent focus:outline-none";
const MONEY = `${INPUT} font-mono text-[0.85rem] tabular-nums sm:text-right`;
const LABEL = "block px-1 font-mono text-[0.55rem] uppercase tracking-kicker text-cream-dimmer sm:hidden";

function RecipientSection({
  G,
  totals,
  fam,
  confirm,
  isNew,
  onFocused,
  onBudget,
  onAddGift,
  onRemovePerson,
  onGift,
  onDeleteGift,
}: {
  G: Group;
  totals: Totals | null;
  fam: ReturnType<typeof familySplit>;
  confirm: string | null;
  isNew: (giftId: string) => boolean;
  onFocused: () => void;
  onBudget: (v: string) => void;
  onAddGift: () => void;
  onRemovePerson: () => void;
  onGift: (g: Gift, patch: Record<string, unknown>) => void;
  onDeleteGift: (g: Gift) => void;
}) {
  const p = G.person;
  const family = G.kind === "family";
  // A person's numbers come from personTotals (own gifts + a core member's
  // sixth of Family); a gift-only recipient just sums its own gifts.
  const ownEst = G.gifts.reduce((s, g) => s + (num(g.est) || 0), 0);
  const ownSpent = G.gifts.reduce((s, g) => s + (num(g.actual) || 0), 0);
  const est = totals ? totals.est : ownEst;
  const spent = totals ? totals.spent : ownSpent;
  const share = totals && (totals.familySpent > 0 || totals.familyEst > 0) ? totals : null;
  const bought = G.gifts.filter((g) => BOUGHT.has(g.status)).length;
  const budget = p ? num(p.budget) : null;
  const left = budget != null ? budget - spent : null;
  const over = budget != null && spent > budget;
  const ck = "rm:" + (p ? p.id : "");
  return (
    <section className={`border bg-ink-raised/40 ${family ? "border-cat-xmas/40" : "border-rule/60"}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 pb-2.5 pt-3">
        <h2 className="font-display text-[1.35rem] leading-tight text-cream">{G.name}</h2>
        {family ? (
          <span className="font-mono text-[0.6rem] uppercase tracking-kicker text-cat-xmas">Shared by all six</span>
        ) : p && p.role ? (
          <span className="font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dimmer">{p.role}</span>
        ) : null}
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-[0.68rem] tabular-nums text-cream-dim max-sm:w-full sm:ml-auto">
          {family ? (
            <>
              <span>
                spent <b className="font-medium text-cream">{money(fam.spent)}</b>
              </span>
              <span>
                est. <b className="font-medium text-cream">{money(fam.est)}</b>
              </span>
            </>
          ) : (
            <>
              <label className="inline-flex items-baseline gap-1">
                budget
                <Field
                  className="w-[5.5rem] border-b border-dashed border-rule bg-transparent px-0.5 text-right text-[0.8rem] text-cream placeholder:text-cream-dimmer focus:border-accent focus:outline-none"
                  inputMode="decimal"
                  placeholder="none"
                  aria-label={"Budget for " + G.name}
                  value={budget == null ? "" : money(budget)}
                  onCommit={onBudget}
                />
              </label>
              <span>
                spent <b className="font-medium text-cream">{money(spent)}</b>
              </span>
              {left != null ? (
                <span className={left < 0 ? "text-accent" : ""}>
                  left <b className={`font-medium ${left < 0 ? "text-accent" : "text-cream"}`}>{money(left)}</b>
                </span>
              ) : (
                <span>
                  est. <b className="font-medium text-cream">{money(est)}</b>
                </span>
              )}
            </>
          )}
          <span>
            {bought}/{G.gifts.length} bought
          </span>
        </div>
        {family ? (
          <p className="w-full font-mono text-[0.62rem] leading-snug text-cat-xmas">
            Split six ways: {money(fam.eachSpent)} spent and {money(fam.eachEst)} planned against each of{" "}
            {CORE_PEOPLE.map((c) => c.name).join(", ").replace(/, ([^,]*)$/, " and $1")}.
          </p>
        ) : share ? (
          <p className="w-full font-mono text-[0.62rem] leading-snug text-cream-dimmer">
            includes <span className="text-cat-xmas">{money(share.familySpent)}</span> spent
            {share.familyEst ? <> ({money(share.familyEst)} planned)</> : null} as a sixth of the Family gifts
          </p>
        ) : null}
      </div>
      {budget ? (
        <div className="relative h-1.5 bg-rule/40" role="img" aria-label={`${money(spent)} spent of ${money(budget)}`}>
          <i className="absolute inset-y-0 left-0 bg-cat-xmas/35" style={{ width: Math.min(100, (est / budget) * 100) + "%" }} />
          <i
            className={`absolute inset-y-0 left-0 ${over ? "bg-accent" : "xmas-candy"}`}
            style={{ width: Math.min(100, (spent / budget) * 100) + "%" }}
          />
        </div>
      ) : (
        <div className="h-px bg-rule/50" />
      )}
      {G.gifts.length > 0 && (
        <div className="hidden grid-cols-[1.25rem_minmax(0,2.2fr)_minmax(0,1fr)_5.5rem_5.5rem_6.5rem_1.75rem] gap-2 px-4 pt-2.5 font-mono text-[0.55rem] uppercase tracking-kicker text-cream-dimmer sm:grid">
          <span />
          <span className="px-1">Gift</span>
          <span className="px-1">From</span>
          <span className="px-1 text-right">Est.</span>
          <span className="px-1 text-right">Actual</span>
          <span className="text-center">Status</span>
          <span />
        </div>
      )}
      {G.gifts.map((g, i) => (
        <GiftRow
          key={g.id}
          g={g}
          first={i === 0}
          confirming={confirm === "del:" + g.id}
          autoFocusIdea={isNew(g.id)}
          onFocused={onFocused}
          onPatch={(patch) => onGift(g, patch)}
          onDelete={() => onDeleteGift(g)}
        />
      ))}
      <div className="flex items-center justify-between gap-2 px-3 pb-2.5 pt-1.5 font-mono text-[0.66rem] uppercase tracking-kicker">
        <button type="button" onClick={onAddGift} className="px-1 py-1.5 text-cat-xmas hover:text-cream">
          + Add gift
        </button>
        {p && G.kind !== "core" ? (
          <button
            type="button"
            onClick={onRemovePerson}
            className={`px-1 py-1.5 ${confirm === ck ? "text-accent" : "text-cream-dimmer hover:text-accent"}`}
          >
            {confirm === ck ? `Tap again to remove ${G.name}` : "Remove from budget"}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function GiftRow({
  g,
  first,
  confirming,
  autoFocusIdea,
  onFocused,
  onPatch,
  onDelete,
}: {
  g: Gift;
  first: boolean;
  confirming: boolean;
  autoFocusIdea: boolean;
  onFocused: () => void;
  onPatch: (patch: Record<string, unknown>) => void;
  onDelete: () => void;
}) {
  const st = (STATUSES as readonly string[]).includes(g.status) ? g.status : "Idea";
  const done = BOUGHT.has(st);
  const ideaRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocusIdea) {
      ideaRef.current?.focus();
      onFocused();
    }
  }, [autoFocusIdea, onFocused]);
  return (
    <div
      className={`grid grid-cols-[1.25rem_minmax(0,1fr)_minmax(0,1fr)_1.75rem] items-center gap-x-2 gap-y-1 px-4 py-2.5 sm:grid-cols-[1.25rem_minmax(0,2.2fr)_minmax(0,1fr)_5.5rem_5.5rem_6.5rem_1.75rem] sm:py-1.5 ${
        first ? "max-sm:border-t max-sm:border-rule/40" : "border-t border-rule/40"
      }`}
    >
      <input
        className="h-4 w-4 cursor-pointer justify-self-center accent-cat-xmas max-sm:row-[1]"
        type="checkbox"
        aria-label="Purchased"
        title="Mark purchased"
        checked={done}
        onChange={(e) => {
          const patch: Record<string, unknown> = { status: e.target.checked ? "Purchased" : "Planned" };
          if (e.target.checked && num(g.actual) == null && num(g.est) != null) patch.actual = num(g.est);
          onPatch(patch);
        }}
      />
      <label className="min-w-0 max-sm:col-[2/4]">
        <Field
          className={`${INPUT} font-display text-[1.05rem] ${done ? "text-cream-dim line-through decoration-cream-dimmer" : ""}`}
          inputRef={ideaRef}
          value={g.idea || ""}
          placeholder="Gift idea"
          aria-label="Gift idea"
          onCommit={(v) => onPatch({ idea: v.trim() })}
        />
      </label>
      <label className="min-w-0 max-sm:col-[1/3] max-sm:row-[2]">
        <span className={LABEL}>From</span>
        <Field className={`${INPUT} font-display text-[0.95rem]`} value={g.from || ""} placeholder="From" aria-label="From" onCommit={(v) => onPatch({ from: v.trim() })} />
      </label>
      <label className="min-w-0 max-sm:col-[1/3] max-sm:row-[3]">
        <span className={LABEL}>Est.</span>
        <Field className={MONEY} inputMode="decimal" value={money(num(g.est))} placeholder="$" aria-label="Estimated cost" onCommit={(v) => onPatch({ est: num(v) })} />
      </label>
      <label className="min-w-0 max-sm:col-[3/5] max-sm:row-[3]">
        <span className={LABEL}>Actual</span>
        <Field className={MONEY} inputMode="decimal" value={money(num(g.actual))} placeholder="$" aria-label="Actual cost" onCommit={(v) => onPatch({ actual: num(v) })} />
      </label>
      <label className="min-w-0 max-sm:col-[3/5] max-sm:row-[2]">
        <span className={LABEL}>Status</span>
        <select
          className={`w-full cursor-pointer appearance-none rounded-full border bg-transparent px-2 py-0.5 text-center font-mono text-[0.6rem] uppercase tracking-kicker [text-align-last:center] max-sm:w-auto max-sm:px-3 ${STATUS_STYLE[st]}`}
          aria-label="Status"
          value={st}
          onChange={(e) => onPatch({ status: e.target.value })}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s === "Wrapped" ? "Wrapped ✶" : s}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        aria-label="Delete gift"
        onClick={onDelete}
        className={`justify-self-end font-mono max-sm:col-[4] max-sm:row-[1] ${
          confirming ? "whitespace-nowrap bg-accent px-1.5 py-0.5 text-[0.6rem] uppercase tracking-kicker text-ink" : "px-1 text-[1rem] text-cream-dimmer hover:text-accent"
        }`}
      >
        {confirming ? "Delete?" : "×"}
      </button>
      <label className="col-span-full min-w-0 sm:col-start-2">
        <Field
          className={`${INPUT} py-0.5 font-display text-[0.85rem] italic text-cream-dim`}
          value={g.notes || ""}
          placeholder="Notes, links, sizes…"
          aria-label="Notes"
          onCommit={(v) => onPatch({ notes: v.trim() })}
        />
      </label>
    </div>
  );
}
