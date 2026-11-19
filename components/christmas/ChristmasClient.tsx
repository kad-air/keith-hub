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
  STATUSES,
  cleanGift,
  key,
  money,
  num,
  slug,
  type Gift,
  type ListState,
  type Person,
} from "@/lib/christmas/shared";

// The shared Christmas gift list — a port of the Claude artifact
// christmas-list.html. Layout, copy and behaviour follow the original; what
// changed is everything it got from the artifact platform:
//   • storage: the `db` capability → /api/christmas/* over the hub's SQLite
//     (lib/christmas/store.ts). Paths keep the original's doc names
//     ("gifts/<id>", "people/<id>", "config/main") so applyOps and Undo read
//     the same as before.
//   • live updates: db snapshots → a poll every few seconds that asks "has
//     anything changed since rev N?". Writes show at once (applied locally
//     first); a poll never lands while a write is still in flight, and a
//     field being typed in keeps its draft whatever arrives (Field, below).
//   • the helper: `sample.json` → POST /api/christmas/helper, which calls the
//     Anthropic API on the server. Its ops are validated and applied here,
//     exactly as the original did.
//   • identity: no `user` capability and no read-only mode — whoever is past
//     the passcode can edit.

type Data = { people: Person[]; gifts: Gift[]; total: number | null; rev: number };
type UndoStep = { t: "del"; path: string } | { t: "set"; path: string; data: Record<string, unknown> };
type Msg = {
  id: number;
  cls: "u" | "a" | "a err";
  text: string;
  done?: string[];
  undo?: UndoStep[];
  undoState?: "idle" | "busy" | "done";
};
type Group = { name: string; person: Person | null; gifts: Gift[] };

const POLL_MS = 3000;

const COPY: Record<string, string> = {
  sampling_disabled: "The helper isn't available on this account.",
  rate_limited: "Too many requests right now. Try again in a little while.",
  session_expired: "Please sign in again, then retry.",
  refused: "I can't help with that request.",
  invalid_json: "I got muddled on that one. Try rephrasing.",
  prompt_too_large: "The list is too big for me to read in one go.",
};

const CHIPS = [
  "What's left to buy?",
  "Who is over or close to budget?",
  "Suggest 3 stocking stuffers for each kid and add them as ideas",
];

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
  const [countdown, setCountdown] = useState("");
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

  /* ---------- countdown ---------- */
  useEffect(() => {
    const now = new Date();
    let x = new Date(now.getFullYear(), 11, 25);
    if (now > x && now.toDateString() !== x.toDateString()) x = new Date(now.getFullYear() + 1, 11, 25);
    const d = Math.round((x.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 864e5);
    setCountdown(d === 0 ? "It's Christmas Day" : d + (d === 1 ? " day" : " days") + " until Christmas");
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
    const groups = new Map<string, Group>();
    for (const p of people) groups.set(key(p.name), { name: p.name, person: p, gifts: [] });
    for (const g of gifts) {
      const k = key(g.recipient) || "(unassigned)";
      if (!groups.has(k)) groups.set(k, { name: g.recipient || "Unassigned", person: null, gifts: [] });
      groups.get(k)!.gifts.push(g);
    }
    let est = 0, spent = 0, bought = 0;
    for (const g of gifts) {
      est += num(g.est) || 0;
      spent += num(g.actual) || 0;
      if (BOUGHT.has(g.status)) bought++;
    }
    return { people, gifts, groups: [...groups.values()], est, spent, bought };
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

  /* ---------- helper chat ---------- */
  const turns = useRef<{ role: "user" | "assistant"; content: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [chipsHidden, setChipsHidden] = useState(false);
  const [askHidden, setAskHidden] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [box, setBox] = useState("");
  const msgSeq = useRef(0);
  const msgsEl = useRef<HTMLDivElement>(null);
  const boxEl = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = msgsEl.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, chipsHidden]);

  const addMsg = (m: Omit<Msg, "id">) => {
    const id = ++msgSeq.current;
    setMsgs((list) => [...list, { ...m, id }]);
    return id;
  };
  const editMsg = (id: number, patch: Partial<Msg>) =>
    setMsgs((list) => list.map((m) => (m.id === id ? { ...m, ...patch } : m)));

  async function applyOps(ops: Record<string, unknown>[]) {
    const done: string[] = [], undo: UndoStep[] = [];
    for (const o of ops.slice(0, 40)) {
      if (!o || typeof o !== "object") continue;
      try {
        if (o.op === "add_gift") {
          const d = cleanGift(o);
          if (!d.idea) continue;
          if (!d.recipient) d.recipient = "Family";
          const ex = model().groups.find((G) => key(G.name) === key(d.recipient));
          if (ex) d.recipient = ex.name;
          d.createdAt = Date.now() + done.length;
          const [id, saved] = newGift(d);
          await saved;
          undo.push({ t: "del", path: "gifts/" + id });
          done.push("Added “" + d.idea + "” for " + d.recipient + (d.est != null ? " (" + money(d.est) + ")" : ""));
        } else if (o.op === "update_gift") {
          const g = D.current.gifts.find((x) => x.id === String(o.id));
          if (!g) continue;
          const d = cleanGift(o);
          if (!Object.keys(d).length) continue;
          const prev: Record<string, unknown> = { ...g };
          delete prev.id;
          await updGift(g.id, d);
          undo.push({ t: "set", path: "gifts/" + g.id, data: prev });
          done.push(
            "Updated “" + (d.idea || g.idea || "gift") + "”: " +
              Object.keys(d)
                .map((f) => {
                  const v = (d as Record<string, unknown>)[f];
                  return f + " → " + (f === "est" || f === "actual" ? (v == null ? "blank" : money(v as number)) : v);
                })
                .join(", "),
          );
        } else if (o.op === "delete_gift") {
          const g = D.current.gifts.find((x) => x.id === String(o.id));
          if (!g) continue;
          const prev: Record<string, unknown> = { ...g };
          delete prev.id;
          await docDel("gifts/" + g.id);
          undo.push({ t: "set", path: "gifts/" + g.id, data: prev });
          done.push("Deleted “" + (g.idea || "gift") + "” (" + g.recipient + ")");
        } else if (o.op === "set_budget") {
          const name = String(o.person || "").trim();
          if (!name) continue;
          const b = o.budget == null ? null : num(o.budget);
          const p = D.current.people.find((x) => key(x.name) === key(name));
          if (p) {
            const prev: Record<string, unknown> = { ...p };
            delete prev.id;
            const patch: Record<string, unknown> = { budget: b };
            if (typeof o.role === "string") patch.role = o.role.slice(0, 60);
            await docUpd("people/" + p.id, patch);
            undo.push({ t: "set", path: "people/" + p.id, data: prev });
            done.push(p.name + " budget → " + (b == null ? "none" : money(b)));
          } else {
            const id = uniqueId(name);
            await setPerson(id, {
              name: name.slice(0, 60),
              role: typeof o.role === "string" ? o.role.slice(0, 60) : "",
              budget: b,
              order: nextOrder() + done.length,
            });
            undo.push({ t: "del", path: "people/" + id });
            done.push("Added " + name + " with budget " + (b == null ? "none" : money(b)));
          }
        } else if (o.op === "remove_person") {
          const p = D.current.people.find((x) => key(x.name) === key(o.person));
          if (!p) continue;
          const prev: Record<string, unknown> = { ...p };
          delete prev.id;
          await docDel("people/" + p.id);
          undo.push({ t: "set", path: "people/" + p.id, data: prev });
          done.push("Removed " + p.name + " from the budget");
        } else if (o.op === "set_total_budget") {
          const n = num(o.amount);
          if (n == null) continue;
          const prev = D.current.total;
          await setTotal(n);
          undo.push(prev == null ? { t: "del", path: "config/main" } : { t: "set", path: "config/main", data: { totalBudget: prev } });
          done.push("Total budget → " + money(n));
        }
      } catch {
        done.push("Couldn't apply one change (" + String(o.op) + ")");
      }
    }
    return { done, undo };
  }

  async function runUndo(steps: UndoStep[]) {
    for (const u of steps.slice().reverse()) {
      if (u.t === "del") await docDel(u.path);
      else await docSet(u.path, u.data);
    }
  }

  async function ask(text: string) {
    if (busy || !text.trim()) return;
    setBusy(true);
    setChipsHidden(true);
    addMsg({ cls: "u", text });
    const wait = addMsg({ cls: "a", text: "Thinking…" });
    try {
      // Let any edit still on its way land first, so the helper reads it.
      await Promise.all(Object.values(q.current));
      const r = await fetch("/api/christmas/helper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, turns: turns.current.slice(-10) }),
      });
      if (r.status === 401) {
        signedOut();
        throw new ApiError("session_expired", 401);
      }
      const res = (await r.json().catch(() => ({ error: { code: "upstream" } }))) as {
        reply?: unknown;
        ops?: unknown;
        error?: { code?: string };
      };
      if (res.error) throw new ApiError(res.error.code || "upstream", r.status);
      const reply = String(res.reply || "Done.");
      const ops = Array.isArray(res.ops) ? (res.ops as Record<string, unknown>[]) : [];
      const { done, undo } = await applyOps(ops);
      editMsg(wait, { text: reply, done, undo, undoState: "idle" });
      turns.current.push(
        { role: "user", content: text },
        { role: "assistant", content: reply + (done.length ? "\n[Changes made: " + done.join("; ") + "]" : "") },
      );
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "";
      editMsg(wait, { cls: "a err", text: COPY[code] || "Something went wrong reaching the helper. Try again." });
      if (code === "sampling_disabled") setAskHidden(true);
    } finally {
      setBusy(false);
    }
  }

  async function undoBatch(m: Msg) {
    if (!m.undo) return;
    editMsg(m.id, { undoState: "busy" });
    try {
      await runUndo(m.undo);
      editMsg(m.id, { undoState: "done" });
    } catch {
      editMsg(m.id, { undoState: "idle" });
      toast("Couldn't undo everything.");
    }
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
    if (m.groups.some((G) => key(G.name) === key(name) && G.person)) {
      toast(name + " is already on the list.");
      return;
    }
    el.value = "";
    setPerson(uniqueId(name), { name, role: "", budget: null, order: nextOrder() }).catch(() => {});
  }

  return (
    <>
      <div className="wrap">
        <header className="top">
          <h1>Adair Christmas 2026</h1>
          <span className="count">{countdown}</span>
        </header>
        {banner && <div className="banner">{banner}</div>}

        <div className="tiles">
          <div className="tile">
            <div className="lab">Total budget</div>
            <Field
              className="val"
              inputMode="decimal"
              aria-label="Total budget"
              placeholder="Set budget"
              value={total == null ? "" : money(total)}
              onCommit={(v) => setTotal(num(v)).catch(() => {})}
            />
            <div className="sub">{money(alloc)} assigned to people</div>
          </div>
          <div className="tile">
            <div className="lab">Estimated</div>
            <div className="val">{money(m.est)}</div>
            <div className={"sub" + (unplanned != null && unplanned < 0 ? " neg" : "")}>
              {unplanned == null ? " " : unplanned >= 0 ? money(unplanned) + " not yet planned" : money(-unplanned) + " over budget"}
            </div>
          </div>
          <div className="tile">
            <div className="lab">Remaining</div>
            <div className={"val" + (rem != null && rem < 0 ? " neg" : "")}>{rem == null ? "—" : money(rem)}</div>
            <div className="sub">{money(m.spent)} spent so far</div>
          </div>
          <div className="tile">
            <div className="lab">Gifts purchased</div>
            <div className="val">{m.bought}</div>
            <div className="sub">
              of {m.gifts.length} planned gift{m.gifts.length === 1 ? "" : "s"}
            </div>
          </div>
        </div>

        <div className="cols">
          <main className="list">
            {!m.groups.length && (
              <div className="empty">No one on the list yet. Add a person below, or ask the helper to set things up.</div>
            )}
            {m.groups.map((G) => (
              <RecipientSection
                key={G.person ? "p:" + G.person.id : "n:" + key(G.name)}
                G={G}
                confirm={confirm}
                focusNext={focusNext}
                onFocused={() => setFocusNext(null)}
                onBudget={(v) => {
                  const b = num(v);
                  if (G.person) docUpd("people/" + G.person.id, { budget: b }).catch(() => {});
                  else if (b != null)
                    setPerson(uniqueId(G.name), { name: G.name, role: "", budget: b, order: nextOrder() }).catch(() => {});
                }}
                onAddGift={() => {
                  const [id, saved] = newGift({ recipient: G.name });
                  setFocusNext("g:" + id + ":idea");
                  saved.catch(() => {});
                }}
                onRemovePerson={() => {
                  const p = G.person!;
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
            <form className="addp" onSubmit={addPerson}>
              <input
                ref={newName}
                placeholder="Add a person or group (e.g. Grandma, Teachers)"
                aria-label="New recipient name"
                maxLength={60}
              />
              <button className="btn ghost" type="submit">
                Add recipient
              </button>
            </form>
          </main>

          <aside className={"chat" + (chatOpen ? " open" : "")} aria-label="List helper">
            <div className="chead">
              <div>
                <h2>List helper</h2>
                <p>Adds, edits and tidies gifts and budgets.</p>
              </div>
              <button className="x" id="closeChat" type="button" aria-label="Close helper" onClick={() => setChatOpen(false)}>
                ✕
              </button>
            </div>
            <div className="msgs" ref={msgsEl}>
              <div className="m a">
                Tell me what to change — “add a $40 Lego set for Hudson from Parents”, “mark the game table purchased at
                $185”, “give each kid $50 more budget”.
              </div>
              {!chipsHidden && (
                <div className="chips">
                  {CHIPS.map((c) => (
                    <button key={c} className="chip" type="button" onClick={() => ask(c)}>
                      {c}
                    </button>
                  ))}
                </div>
              )}
              {msgs.map((msg) => (
                <div key={msg.id} className={"m " + msg.cls}>
                  {msg.text}
                  {msg.done && msg.done.length > 0 && (
                    <>
                      <ul>
                        {msg.done.map((d, i) => (
                          <li key={i}>{d}</li>
                        ))}
                      </ul>
                      <button
                        className="undo"
                        type="button"
                        disabled={msg.undoState !== "idle"}
                        onClick={() => undoBatch(msg)}
                      >
                        {msg.undoState === "done" ? "Undone" : "Undo"}
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
            {!askHidden && (
              <form
                className="ask"
                onSubmit={(e) => {
                  e.preventDefault();
                  const v = box;
                  setBox("");
                  void ask(v);
                }}
              >
                <textarea
                  ref={boxEl}
                  value={box}
                  onChange={(e) => setBox(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      e.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder="Ask the helper…"
                  aria-label="Message the helper"
                  maxLength={1000}
                />
                <button className="btn" type="submit" disabled={busy}>
                  Send
                </button>
              </form>
            )}
          </aside>
        </div>
      </div>
      {!chatOpen && (
        <button
          className="btn"
          id="fab"
          type="button"
          onClick={() => {
            setChatOpen(true);
            setTimeout(() => boxEl.current?.focus(), 0);
          }}
        >
          Ask helper
        </button>
      )}
      {toastMsg && <div id="toast">{toastMsg}</div>}
    </>
  );
}

function RecipientSection({
  G,
  confirm,
  focusNext,
  onFocused,
  onBudget,
  onAddGift,
  onRemovePerson,
  onGift,
  onDeleteGift,
}: {
  G: Group;
  confirm: string | null;
  focusNext: string | null;
  onFocused: () => void;
  onBudget: (v: string) => void;
  onAddGift: () => void;
  onRemovePerson: () => void;
  onGift: (g: Gift, patch: Record<string, unknown>) => void;
  onDeleteGift: (g: Gift) => void;
}) {
  const p = G.person;
  const est = G.gifts.reduce((s, g) => s + (num(g.est) || 0), 0);
  const spent = G.gifts.reduce((s, g) => s + (num(g.actual) || 0), 0);
  const bought = G.gifts.filter((g) => BOUGHT.has(g.status)).length;
  const budget = p ? num(p.budget) : null;
  const ck = "rm:" + (p ? p.id : "");
  return (
    <section className="rcp">
      <div className="rhead">
        <h2>{G.name}</h2>
        {p && p.role ? <span className="role">{p.role}</span> : null}
        <div className="stats">
          <label className="bud">
            Budget
            <Field
              className="fi money"
              inputMode="decimal"
              placeholder="none"
              aria-label={"Budget for " + G.name}
              value={budget == null ? "" : money(budget)}
              onCommit={onBudget}
            />
          </label>
          <span>
            Spent <b>{money(spent)}</b>
          </span>
          {budget != null ? (
            <span className={budget - spent < 0 ? "neg" : ""}>
              Left <b className={budget - spent < 0 ? "neg" : ""}>{money(budget - spent)}</b>
            </span>
          ) : (
            <span>
              Est. <b>{money(est)}</b>
            </span>
          )}
          <span>
            {bought} of {G.gifts.length} bought
          </span>
        </div>
      </div>
      {budget ? (
        <div className={"bar" + (spent > budget ? " over" : "")} role="img" aria-label={money(spent) + " spent of " + money(budget)}>
          <i className="est" style={{ width: Math.min(100, (est / budget) * 100) + "%" }} />
          <i className="spent" style={{ width: Math.min(100, (spent / budget) * 100) + "%" }} />
        </div>
      ) : null}
      {G.gifts.length > 0 && (
        <div className="colhead">
          <span />
          <span>Gift</span>
          <span>From</span>
          <span>Est.</span>
          <span>Actual</span>
          <span>Status</span>
          <span />
        </div>
      )}
      {G.gifts.map((g) => (
        <GiftRow
          key={g.id}
          g={g}
          confirming={confirm === "del:" + g.id}
          autoFocusIdea={focusNext === "g:" + g.id + ":idea"}
          onFocused={onFocused}
          onPatch={(patch) => onGift(g, patch)}
          onDelete={() => onDeleteGift(g)}
        />
      ))}
      <div className="rfoot">
        <button className="link" type="button" onClick={onAddGift}>
          + Add gift
        </button>
        {p ? (
          <button className="link quiet" type="button" onClick={onRemovePerson}>
            {confirm === ck ? "Tap again to remove " + G.name : "Remove from budget"}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function GiftRow({
  g,
  confirming,
  autoFocusIdea,
  onFocused,
  onPatch,
  onDelete,
}: {
  g: Gift;
  confirming: boolean;
  autoFocusIdea: boolean;
  onFocused: () => void;
  onPatch: (patch: Record<string, unknown>) => void;
  onDelete: () => void;
}) {
  const st = (STATUSES as readonly string[]).includes(g.status) ? g.status : "Idea";
  const ideaRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocusIdea) {
      ideaRef.current?.focus();
      onFocused();
    }
  }, [autoFocusIdea, onFocused]);
  return (
    <div className={"gift" + (BOUGHT.has(st) ? " done" : "")}>
      <input
        className="chk"
        type="checkbox"
        aria-label="Purchased"
        title="Mark purchased"
        checked={BOUGHT.has(st)}
        onChange={(e) => {
          const patch: Record<string, unknown> = { status: e.target.checked ? "Purchased" : "Planned" };
          if (e.target.checked && num(g.actual) == null && num(g.est) != null) patch.actual = num(g.est);
          onPatch(patch);
        }}
      />
      <label className="f idea">
        <span>Gift</span>
        <Field
          className="fi"
          inputRef={ideaRef}
          value={g.idea || ""}
          placeholder="Gift idea"
          aria-label="Gift idea"
          onCommit={(v) => onPatch({ idea: v.trim() })}
        />
      </label>
      <label className="f from">
        <span>From</span>
        <Field className="fi" value={g.from || ""} placeholder="From" aria-label="From" onCommit={(v) => onPatch({ from: v.trim() })} />
      </label>
      <label className="f est">
        <span>Est.</span>
        <Field
          className="fi money"
          inputMode="decimal"
          value={money(num(g.est))}
          placeholder="$"
          aria-label="Estimated cost"
          onCommit={(v) => onPatch({ est: num(v) })}
        />
      </label>
      <label className="f actual">
        <span>Actual</span>
        <Field
          className="fi money"
          inputMode="decimal"
          value={money(num(g.actual))}
          placeholder="$"
          aria-label="Actual cost"
          onCommit={(v) => onPatch({ actual: num(v) })}
        />
      </label>
      <label className="f status">
        <span>Status</span>
        <select className={"fi s-" + st.toLowerCase()} aria-label="Status" value={st} onChange={(e) => onPatch({ status: e.target.value })}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <button className={"x" + (confirming ? " sure" : "")} type="button" aria-label="Delete gift" onClick={onDelete}>
        {confirming ? "Delete?" : "✕"}
      </button>
      <label className="f notes">
        <span>Notes</span>
        <Field className="fi" value={g.notes || ""} placeholder="Notes, links, sizes…" aria-label="Notes" onCommit={(v) => onPatch({ notes: v.trim() })} />
      </label>
    </div>
  );
}
