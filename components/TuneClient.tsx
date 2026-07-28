"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AlgorithmConfig, AppConfig, SourceConfig } from "@/lib/config";

// ── Types mirrored from the /api/tune endpoints ─────────────────────────────

interface ConfigResponse {
  yaml: string;
  config: AppConfig;
  source: "db" | "repo";
  dirty: boolean;
}

interface SourceHealth {
  id: string;
  unread: number;
  itemsPerWeek: number;
  lastFetchedAt: string | null;
  lastError: string | null;
}

interface DetectResult {
  kind: "rss" | "podcast" | "bluesky_account" | "bluesky_feed";
  title: string;
  itemTitles: string[];
  suggested: Partial<SourceConfig>;
}

interface PreviewResponse {
  sequence: string[];
  counts: Record<string, number>;
  total: number;
}

type Pane = "sources" | "algorithm" | "yaml";

// ── Display constants ────────────────────────────────────────────────────────

// Client-side mirror of ALGORITHM_DEFAULTS in lib/config.ts, in YAML field
// names (this component edits the algorithm *block*, not the resolved shape).
const ALGO_DEFAULTS: Required<Omit<AlgorithmConfig, "surprise_pool" | "ttl_days">> & {
  ttl_days: number;
} = {
  priority: {
    music: 4,
    books: 4,
    film: 4,
    tech_review: 4,
    podcasts: 3,
    reading: 2,
    bluesky: 1,
  },
  bsky_ratio: 4,
  bsky_window: 100,
  surprise: 3,
  jitter: 0.35,
  ttl_days: 7,
  retention_days: 7,
};

const PRIORITY_CATEGORIES: Array<{ id: string; label: string }> = [
  { id: "music", label: "Music" },
  { id: "books", label: "Books" },
  { id: "film", label: "Film" },
  { id: "tech_review", label: "Tech reviews" },
  { id: "podcasts", label: "Podcasts" },
  { id: "reading", label: "Reading" },
  { id: "bluesky", label: "Bluesky" },
];

const CAT_DOT: Record<string, string> = {
  music: "bg-cat-music",
  books: "bg-cat-books",
  film: "bg-cat-film",
  tech_review: "bg-cat-tech_review",
  podcasts: "bg-cat-podcasts",
  reading: "bg-cat-reading",
  bluesky: "bg-cat-bluesky",
};

const INTERVAL_OPTIONS = [3, 5, 10, 15, 30, 60];

function catDot(category: string): string {
  return CAT_DOT[category] ?? "bg-cream-dimmer";
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr} h ago`;
  return `${Math.floor(hr / 24)} d ago`;
}

function domainOf(source: SourceConfig): string {
  if (source.type === "bluesky") {
    return source.mode === "account" ? `@${source.handle}` : source.mode ?? "bluesky";
  }
  try {
    return new URL(source.url ?? "").hostname.replace(/^www\./, "");
  } catch {
    return source.url ?? "";
  }
}

// ── Small shared UI atoms ────────────────────────────────────────────────────

function Kicker({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="font-mono text-[0.68rem] uppercase tracking-kicker text-cream-dim">
      {children}
    </h3>
  );
}

function GhostButton({
  children,
  onClick,
  disabled,
  danger,
  active,
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  active?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={[
        "shrink-0 rounded-sm border px-2 py-1 font-mono text-[0.66rem] uppercase tracking-kicker transition-colors disabled:opacity-40",
        active
          ? "border-accent/30 bg-accent-soft text-accent"
          : danger
            ? "border-rule text-cream-dimmer hover:border-accent hover:text-accent"
            : "border-rule text-cream-dim hover:border-rule-strong hover:text-cream",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

export default function TuneClient() {
  const [pane, setPane] = useState<Pane>("sources");
  const [data, setData] = useState<ConfigResponse | null>(null);
  const [health, setHealth] = useState<Record<string, SourceHealth>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showStatus = useCallback((msg: string) => {
    setStatus(msg);
    if (statusTimer.current) clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setStatus(null), 3500);
  }, []);

  const loadHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/tune/sources");
      if (!res.ok) return;
      const json = (await res.json()) as { sources: SourceHealth[] };
      setHealth(Object.fromEntries(json.sources.map((s) => [s.id, s])));
    } catch {
      /* roster stats are decorative — leave whatever we have */
    }
  }, []);

  const loadConfig = useCallback(async () => {
    const res = await fetch("/api/tune/config");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as ConfigResponse;
    setData(json);
    setYamlDraft(json.yaml);
    return json;
  }, []);

  useEffect(() => {
    loadConfig().catch(() => showStatus("Couldn't load config"));
    void loadHealth();
  }, [loadConfig, loadHealth, showStatus]);

  // Single write path: PUT either a structured config or raw YAML.
  const putConfig = useCallback(
    async (body: { config?: AppConfig; yaml?: string }, successMsg = "Saved — applies next crawl") => {
      setSaving(true);
      setErrors([]);
      try {
        const res = await fetch("/api/tune/config", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = await res.json();
        if (!res.ok) {
          setErrors((json.errors as string[]) ?? ["Save failed"]);
          return false;
        }
        setData(json as ConfigResponse);
        setYamlDraft((json as ConfigResponse).yaml);
        showStatus(successMsg);
        void loadHealth();
        return true;
      } catch {
        setErrors(["Network error — nothing was saved"]);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [loadHealth, showStatus]
  );

  const mutateSources = useCallback(
    (fn: (sources: SourceConfig[]) => SourceConfig[], successMsg?: string) => {
      if (!data) return;
      const next: AppConfig = { ...data.config, sources: fn([...data.config.sources]) };
      void putConfig({ config: next }, successMsg);
    },
    [data, putConfig]
  );

  // ── Sources pane state ────────────────────────────────────
  const [detectInput, setDetectInput] = useState("");
  const [detecting, setDetecting] = useState(false);
  const [detected, setDetected] = useState<DetectResult | null>(null);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [addCategory, setAddCategory] = useState<string | null>(null);

  const categoryOptions = useMemo(() => {
    const known = PRIORITY_CATEGORIES.map((c) => c.id);
    const fromConfig = data?.config.sources.map((s) => s.category) ?? [];
    return Array.from(new Set([...known, ...fromConfig]));
  }, [data]);

  const runDetect = useCallback(async () => {
    if (!detectInput.trim() || detecting) return;
    setDetecting(true);
    setDetected(null);
    setDetectError(null);
    try {
      const res = await fetch("/api/tune/detect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: detectInput.trim() }),
      });
      const json = await res.json();
      if (!res.ok) {
        setDetectError((json.error as string) ?? "Detection failed");
        return;
      }
      const result = json as DetectResult;
      setDetected(result);
      setAddCategory(result.suggested.category ?? null);
    } catch {
      setDetectError("Network error");
    } finally {
      setDetecting(false);
    }
  }, [detectInput, detecting]);

  const addDetectedSource = useCallback(() => {
    if (!data || !detected || !addCategory) return;
    const existing = new Set(data.config.sources.map((s) => s.id));
    let id = detected.suggested.id || "new-source";
    let n = 2;
    while (existing.has(id)) id = `${detected.suggested.id}-${n++}`;
    const source = {
      ...detected.suggested,
      id,
      category: addCategory,
    } as SourceConfig;
    mutateSources((sources) => [...sources, source], `Added ${source.name}`);
    setDetected(null);
    setDetectInput("");
  }, [data, detected, addCategory, mutateSources]);

  // ── Algorithm pane state ──────────────────────────────────
  // Draft knobs in YAML field names; hydrated from config.algorithm over
  // defaults. ttl_days stays a single number here — a per-category map is
  // a YAML-pane power edit and freezes the slider with a note.
  const savedAlgo = useMemo(() => {
    const a = data?.config.algorithm ?? {};
    return {
      priority: { ...ALGO_DEFAULTS.priority, ...(a.priority ?? {}) },
      bsky_ratio: a.bsky_ratio ?? ALGO_DEFAULTS.bsky_ratio,
      bsky_window: a.bsky_window ?? ALGO_DEFAULTS.bsky_window,
      surprise: a.surprise ?? ALGO_DEFAULTS.surprise,
      jitter: a.jitter ?? ALGO_DEFAULTS.jitter,
      ttl_days: typeof a.ttl_days === "number" ? a.ttl_days : ALGO_DEFAULTS.ttl_days,
      retention_days: a.retention_days ?? ALGO_DEFAULTS.retention_days,
    };
  }, [data]);
  const ttlIsPerCategory = typeof data?.config.algorithm?.ttl_days === "object";

  const [algo, setAlgo] = useState(savedAlgo);
  useEffect(() => setAlgo(savedAlgo), [savedAlgo]);
  const algoDirty = useMemo(
    () => JSON.stringify(algo) !== JSON.stringify(savedAlgo),
    [algo, savedAlgo]
  );

  const saveAlgo = useCallback(() => {
    if (!data) return;
    const block: AlgorithmConfig = {
      ...data.config.algorithm,
      priority: algo.priority,
      bsky_ratio: algo.bsky_ratio,
      bsky_window: algo.bsky_window,
      surprise: algo.surprise,
      jitter: algo.jitter,
      retention_days: algo.retention_days,
    };
    if (!ttlIsPerCategory) block.ttl_days = algo.ttl_days;
    void putConfig({ config: { ...data.config, algorithm: block } });
  }, [data, algo, ttlIsPerCategory, putConfig]);

  // Live preview — debounced dry-run of the All view with the draft knobs.
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewNonce, setPreviewNonce] = useState(0); // bump = re-roll
  useEffect(() => {
    if (pane !== "algorithm") return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/tune/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            priority: algo.priority,
            bsky_ratio: algo.bsky_ratio,
            surprise: algo.surprise,
            jitter: algo.jitter,
          }),
          signal: controller.signal,
        });
        if (res.ok) setPreview((await res.json()) as PreviewResponse);
      } catch {
        /* stale previews are fine */
      }
    }, 300);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [pane, algo.priority, algo.bsky_ratio, algo.surprise, algo.jitter, previewNonce]);

  // ── YAML pane state ───────────────────────────────────────
  const [yamlDraft, setYamlDraft] = useState("");
  const yamlDirty = data !== null && yamlDraft !== data.yaml;

  const copyYaml = useCallback(async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.yaml);
      showStatus("Copied — paste into config/feeds.yml and commit");
    } catch {
      showStatus("Copy failed — select the text manually");
    }
  }, [data, showStatus]);

  const restoreRepo = useCallback(async () => {
    if (!window.confirm("Discard the live config and go back to the repo's feeds.yml?")) return;
    const res = await fetch("/api/tune/config", { method: "DELETE" });
    if (res.ok) {
      const json = (await res.json()) as ConfigResponse;
      setData(json);
      setYamlDraft(json.yaml);
      setErrors([]);
      showStatus("Restored repo config");
      void loadHealth();
    }
  }, [loadHealth, showStatus]);

  // ── Render ────────────────────────────────────────────────

  if (!data) {
    return (
      <div className="mx-auto max-w-[720px] px-2 pb-32 pt-6">
        <div className="px-6 py-24 text-center font-mono text-[0.72rem] uppercase tracking-kicker text-cream-dim">
          Loading…
        </div>
      </div>
    );
  }

  const sourcesByCategory = new Map<string, SourceConfig[]>();
  for (const s of data.config.sources) {
    const list = sourcesByCategory.get(s.category) ?? [];
    list.push(s);
    sourcesByCategory.set(s.category, list);
  }

  return (
    <div className="mx-auto max-w-[720px] px-2 pb-32 pt-6">
      <div className="mb-5 flex items-baseline justify-between px-6">
        <h1 className="font-display text-[1.6rem] font-medium italic text-cream opsz-display">
          Tune
        </h1>
        <span className="font-mono text-[0.68rem] uppercase tracking-kicker text-cream-dimmer">
          {data.source === "db" ? "live: this device" : "live: repo config"}
        </span>
      </div>

      {/* Pane tabs */}
      <div className="mb-6 flex gap-4 px-6">
        {(["sources", "algorithm", "yaml"] as Pane[]).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPane(p)}
            className={[
              "font-mono text-[0.75rem] uppercase tracking-kicker transition-colors",
              pane === p ? "text-cream" : "text-cream-dimmer hover:text-cream-dim",
            ].join(" ")}
          >
            {p === "yaml" ? "YAML" : p}
          </button>
        ))}
      </div>

      {errors.length > 0 && (
        <div className="mx-6 mb-4 border border-accent/40 bg-accent-soft px-4 py-3">
          {errors.map((e, i) => (
            <p key={i} className="font-mono text-[0.72rem] text-accent">
              {e}
            </p>
          ))}
        </div>
      )}

      {/* ── Sources pane ─────────────────────────────────── */}
      {pane === "sources" && (
        <div className="px-6">
          {Array.from(sourcesByCategory.entries()).map(([category, sources]) => (
            <div key={category} className="mb-6">
              <div className="mb-1 flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${catDot(category)}`} />
                <Kicker>{category.replace("_", " ")}</Kicker>
                <span className="font-mono text-[0.62rem] text-cream-dimmer tabular-nums">
                  · {sources.length} {sources.length === 1 ? "source" : "sources"}
                </span>
              </div>
              {sources.map((s) => {
                const h = health[s.id];
                const healthState = s.paused ? "paused" : h?.lastError ? "error" : "ok";
                return (
                  <div
                    key={s.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-rule py-2.5"
                  >
                    <span
                      title={h?.lastError ?? undefined}
                      className={[
                        "h-[7px] w-[7px] shrink-0 rounded-full",
                        healthState === "paused"
                          ? "bg-cream-dimmer/50"
                          : healthState === "error"
                            ? "bg-cat-film shadow-[0_0_0_3px_rgba(236,190,104,0.15)]"
                            : "bg-cat-podcasts",
                      ].join(" ")}
                    />
                    <div className={`min-w-0 flex-1 ${s.paused ? "opacity-50" : ""}`}>
                      <div className="text-[0.95rem] font-semibold text-cream">{s.name}</div>
                      <div className="truncate font-mono text-[0.64rem] text-cream-dimmer">
                        {domainOf(s)} · {s.type}
                        {h ? ` · ${h.itemsPerWeek}/wk · ${h.unread} unread` : ""}
                        {h?.lastError
                          ? ` · failing: ${h.lastError.slice(0, 60)}`
                          : h
                            ? ` · fetched ${timeAgo(h.lastFetchedAt)}`
                            : ""}
                      </div>
                    </div>
                    <select
                      value={s.poll_interval_minutes ?? ""}
                      onChange={(e) =>
                        mutateSources((sources) =>
                          sources.map((x) =>
                            x.id === s.id
                              ? {
                                  ...x,
                                  poll_interval_minutes: e.target.value
                                    ? Number(e.target.value)
                                    : undefined,
                                }
                              : x
                          )
                        )
                      }
                      disabled={saving}
                      aria-label={`Poll interval for ${s.name}`}
                      className="shrink-0 rounded-sm border border-rule bg-ink px-1.5 py-1 font-mono text-[0.66rem] uppercase tracking-kicker text-cream-dim"
                    >
                      <option value="">every crawl</option>
                      {INTERVAL_OPTIONS.map((m) => (
                        <option key={m} value={m}>
                          {m} min
                        </option>
                      ))}
                    </select>
                    <GhostButton
                      active={Boolean(s.paused)}
                      disabled={saving}
                      onClick={() =>
                        mutateSources(
                          (sources) =>
                            sources.map((x) =>
                              x.id === s.id ? { ...x, paused: x.paused ? undefined : true } : x
                            ),
                          s.paused ? `Resumed ${s.name}` : `Paused ${s.name}`
                        )
                      }
                    >
                      {s.paused ? "Paused" : "Pause"}
                    </GhostButton>
                    <GhostButton
                      danger
                      disabled={saving}
                      title="Removes the source and prunes its items on the next crawl"
                      onClick={() => {
                        if (
                          window.confirm(
                            `Delete ${s.name}? Its items are pruned on the next crawl (saved/opened items are kept). Pause instead to keep everything.`
                          )
                        ) {
                          mutateSources(
                            (sources) => sources.filter((x) => x.id !== s.id),
                            `Deleted ${s.name}`
                          );
                        }
                      }}
                    >
                      ✕
                    </GhostButton>
                  </div>
                );
              })}
            </div>
          ))}

          {/* Add source */}
          <div className="mt-8 border-t border-rule-strong pt-5">
            <Kicker>Add a source</Kicker>
            <div className="mt-2 flex gap-2">
              <input
                type="text"
                value={detectInput}
                onChange={(e) => setDetectInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void runDetect();
                }}
                placeholder="Feed URL, site URL, @bluesky-handle, or Apple Podcasts link"
                className="min-w-0 flex-1 rounded-sm border border-rule bg-ink-raised px-3 py-2 font-mono text-[0.72rem] text-cream placeholder:text-cream-dimmer focus:border-rule-strong focus:outline-none"
              />
              <button
                type="button"
                onClick={() => void runDetect()}
                disabled={detecting || !detectInput.trim()}
                className="shrink-0 rounded-sm bg-accent px-4 py-2 font-mono text-[0.7rem] uppercase tracking-kicker text-white transition-opacity disabled:opacity-40"
              >
                {detecting ? "…" : "Detect"}
              </button>
            </div>
            {detectError && (
              <p className="mt-2 font-mono text-[0.7rem] text-accent">{detectError}</p>
            )}
            {detected && (
              <div className="mt-3 border border-rule bg-ink-raised px-4 py-3">
                <p className="font-mono text-[0.66rem] uppercase tracking-kicker text-cat-podcasts">
                  {detected.kind.replace("_", " ")} found — {detected.title}
                </p>
                {detected.itemTitles.length > 0 && (
                  <ul className="mt-2 space-y-0.5">
                    {detected.itemTitles.map((t, i) => (
                      <li key={i} className="truncate text-[0.85rem] text-cream-dim">
                        · {t}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <span className="mr-1 font-mono text-[0.62rem] uppercase tracking-kicker text-cream-dimmer">
                    category
                  </span>
                  {categoryOptions.map((cat) => (
                    <GhostButton
                      key={cat}
                      active={addCategory === cat}
                      onClick={() => setAddCategory(cat)}
                    >
                      {cat.replace("_", " ")}
                    </GhostButton>
                  ))}
                  <span className="flex-1" />
                  <button
                    type="button"
                    onClick={addDetectedSource}
                    disabled={!addCategory || saving}
                    className="rounded-sm bg-accent px-4 py-1.5 font-mono text-[0.7rem] uppercase tracking-kicker text-white transition-opacity disabled:opacity-40"
                  >
                    Add source
                  </button>
                </div>
              </div>
            )}
            <p className="mt-3 font-display text-[0.85rem] italic text-cream-dimmer">
              New sources start fetching on the next crawl. Pausing keeps a source&rsquo;s
              items; deleting prunes them.
            </p>
          </div>
        </div>
      )}

      {/* ── Algorithm pane ───────────────────────────────── */}
      {pane === "algorithm" && (
        <div className="px-6">
          <div className="mb-6">
            <Kicker>Priority</Kicker>
            <p className="mt-1 font-display text-[0.85rem] italic text-cream-dimmer">
              Higher appears earlier and denser in the All view. 0 removes a category from
              All entirely — its own tab still works.
            </p>
            <div className="mt-3">
              {PRIORITY_CATEGORIES.map((cat) => {
                const val = algo.priority[cat.id] ?? 0;
                return (
                  <div key={cat.id} className="flex items-center gap-3 py-1.5">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${catDot(cat.id)}`} />
                    <span className="flex-1 text-[0.95rem] text-cream">{cat.label}</span>
                    <span
                      className={`h-1 rounded-full ${catDot(cat.id)} transition-all`}
                      style={{ width: `${val * 13}px`, opacity: val === 0 ? 0.2 : 0.9 }}
                    />
                    <div className="flex items-center overflow-hidden rounded-sm border border-rule">
                      <button
                        type="button"
                        aria-label={`Decrease ${cat.label} priority`}
                        onClick={() =>
                          setAlgo((a) => ({
                            ...a,
                            priority: { ...a.priority, [cat.id]: Math.max(0, val - 1) },
                          }))
                        }
                        className="h-7 w-7 bg-ink-raised text-cream-dim hover:bg-ink-hover hover:text-cream"
                      >
                        −
                      </button>
                      <span className="w-7 text-center font-mono text-[0.78rem] text-cream tabular-nums">
                        {val}
                      </span>
                      <button
                        type="button"
                        aria-label={`Increase ${cat.label} priority`}
                        onClick={() =>
                          setAlgo((a) => ({
                            ...a,
                            priority: { ...a.priority, [cat.id]: Math.min(9, val + 1) },
                          }))
                        }
                        className="h-7 w-7 bg-ink-raised text-cream-dim hover:bg-ink-hover hover:text-cream"
                      >
                        +
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {(
            [
              {
                key: "bsky_ratio",
                label: "Bluesky mix",
                hint: "1 post per N RSS items · none when RSS is empty",
                min: 1,
                max: 10,
                step: 1,
                fmt: (v: number) => `1 : ${v}`,
              },
              {
                key: "bsky_window",
                label: "Bluesky backlog window",
                hint: "unread posts kept · older ones deleted each crawl",
                min: 25,
                max: 300,
                step: 25,
                fmt: (v: number) => `${v}`,
              },
              {
                key: "surprise",
                label: "Surprise",
                hint: "how far past strict recency the Bluesky sample reaches",
                min: 0,
                max: 6,
                step: 0.5,
                fmt: (v: number) => v.toFixed(1),
              },
              {
                key: "jitter",
                label: "Shuffle",
                hint: "jitter on the interleave cadence · 0 = mechanical",
                min: 0,
                max: 1,
                step: 0.05,
                fmt: (v: number) => v.toFixed(2),
              },
              {
                key: "ttl_days",
                label: "RSS shelf life",
                hint: ttlIsPerCategory
                  ? "per-category map set in YAML — edit it there"
                  : "unread items auto-dismiss after this",
                min: 1,
                max: 21,
                step: 1,
                fmt: (v: number) => `${v} days`,
                disabled: ttlIsPerCategory,
              },
              {
                key: "retention_days",
                label: "Dismissed-item retention",
                hint: "dismissed items are deleted after this · saved & opened kept forever",
                min: 1,
                max: 30,
                step: 1,
                fmt: (v: number) => `${v} days`,
              },
            ] as Array<{
              key: keyof typeof algo & string;
              label: string;
              hint: string;
              min: number;
              max: number;
              step: number;
              fmt: (v: number) => string;
              disabled?: boolean;
            }>
          ).map((s) => {
            const val = algo[s.key] as number;
            return (
              <div key={s.key} className={`py-2 ${s.disabled ? "opacity-50" : ""}`}>
                <div className="flex items-baseline justify-between">
                  <span className="text-[0.95rem] text-cream">{s.label}</span>
                  <span className="font-mono text-[0.72rem] text-accent tabular-nums">
                    {s.fmt(val)}
                  </span>
                </div>
                <p className="font-display text-[0.8rem] italic text-cream-dimmer">{s.hint}</p>
                <input
                  type="range"
                  min={s.min}
                  max={s.max}
                  step={s.step}
                  value={val}
                  disabled={s.disabled}
                  aria-label={s.label}
                  onChange={(e) =>
                    setAlgo((a) => ({ ...a, [s.key]: Number(e.target.value) }))
                  }
                  className="mt-1 w-full accent-[rgb(var(--accent))]"
                />
              </div>
            );
          })}

          {/* Preview strip */}
          <div className="mt-6 border border-rule bg-ink-raised px-4 py-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <Kicker>Preview — next All view</Kicker>
              <span className="font-mono text-[0.66rem] text-cream-dimmer tabular-nums">
                {preview ? `${preview.total} cards` : "…"}
              </span>
            </div>
            {preview && preview.total === 0 && (
              <p className="mt-3 font-display text-[0.85rem] italic text-cream-dimmer">
                Nothing unread right now — the strip fills in as items arrive.
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-[3px]" aria-label="Simulated feed order">
              {(preview?.sequence ?? []).slice(0, 400).map((cat, i) => (
                <span
                  key={i}
                  title={cat}
                  className={`h-5 w-[8px] rounded-[2px] ${catDot(cat)} opacity-90`}
                />
              ))}
            </div>
            {preview && (
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
                {Object.entries(preview.counts).map(([cat, n]) => (
                  <span
                    key={cat}
                    className="inline-flex items-center gap-1.5 font-mono text-[0.62rem] text-cream-dim tabular-nums"
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${catDot(cat)}`} />
                    {cat.replace("_", " ")} {n}
                  </span>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={() => setPreviewNonce((n) => n + 1)}
              className="mt-4 rounded-sm border border-rule px-3 py-1.5 font-mono text-[0.66rem] uppercase tracking-kicker text-cream-dim transition-colors hover:border-rule-strong hover:text-cream"
            >
              ↺ Re-roll shuffle
            </button>
          </div>

          <div className="mt-5 flex justify-end gap-2">
            <GhostButton
              onClick={() =>
                setAlgo({
                  priority: { ...ALGO_DEFAULTS.priority },
                  bsky_ratio: ALGO_DEFAULTS.bsky_ratio,
                  bsky_window: ALGO_DEFAULTS.bsky_window,
                  surprise: ALGO_DEFAULTS.surprise,
                  jitter: ALGO_DEFAULTS.jitter,
                  ttl_days: ALGO_DEFAULTS.ttl_days,
                  retention_days: ALGO_DEFAULTS.retention_days,
                })
              }
            >
              Reset to defaults
            </GhostButton>
            <button
              type="button"
              onClick={saveAlgo}
              disabled={!algoDirty || saving}
              className="rounded-sm bg-accent px-4 py-1.5 font-mono text-[0.7rem] uppercase tracking-kicker text-white transition-opacity disabled:opacity-40"
            >
              {saving ? "Saving…" : "Save & apply"}
            </button>
          </div>
        </div>
      )}

      {/* ── YAML pane ────────────────────────────────────── */}
      {pane === "yaml" && (
        <div className="px-6">
          <p className="mb-3 font-display text-[0.9rem] italic text-cream-dim">
            The live config, as one document — the other panes edit exactly this. The
            repo&rsquo;s <code className="font-mono not-italic text-[0.8rem]">config/feeds.yml</code>{" "}
            is the seed and backup.
          </p>
          <textarea
            value={yamlDraft}
            onChange={(e) => setYamlDraft(e.target.value)}
            rows={24}
            spellCheck={false}
            aria-label="Config YAML"
            className="w-full rounded-sm border border-rule bg-ink-raised px-3 py-3 font-mono text-[0.72rem] leading-relaxed text-cream focus:border-rule-strong focus:outline-none"
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void putConfig({ yaml: yamlDraft })}
              disabled={!yamlDirty || saving}
              className="rounded-sm bg-accent px-4 py-1.5 font-mono text-[0.7rem] uppercase tracking-kicker text-white transition-opacity disabled:opacity-40"
            >
              {saving ? "Saving…" : "Save YAML"}
            </button>
            {yamlDirty && (
              <GhostButton onClick={() => setYamlDraft(data.yaml)}>Discard edits</GhostButton>
            )}
            <span className="flex-1" />
            {data.source === "db" && (
              <GhostButton danger onClick={() => void restoreRepo()}>
                Restore repo config
              </GhostButton>
            )}
          </div>
          <div className="mt-4 border-t border-rule pt-3">
            {data.dirty ? (
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-mono text-[0.66rem] uppercase tracking-kicker text-cat-film">
                  ▲ differs from repo feeds.yml
                </span>
                <GhostButton onClick={() => void copyYaml()}>Copy as YAML</GhostButton>
                <span className="font-display text-[0.8rem] italic text-cream-dimmer">
                  paste into the repo &amp; commit whenever you like
                </span>
              </div>
            ) : (
              <span className="font-mono text-[0.66rem] uppercase tracking-kicker text-cream-dimmer">
                ✓ matches repo feeds.yml
              </span>
            )}
          </div>
        </div>
      )}

      {/* Status pill */}
      {status && (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-6">
          <div className="rounded-sm border border-rule-strong bg-ink-raised px-4 py-2 font-mono text-[0.7rem] uppercase tracking-kicker text-cream shadow-2xl shadow-black/40">
            {status}
          </div>
        </div>
      )}
    </div>
  );
}
