import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { getDb } from "@/lib/db";

// ── Config architecture ─────────────────────────────────────────────────────
//
// The LIVE config is the DB copy: kv key `config_yaml` in SQLite. The repo's
// config/feeds.yml is a SEED and BACKUP — it is read only when the kv key is
// absent (fresh volume, or after an explicit "restore from repo"). The Tune
// UI (and its API) edits the DB copy; "Copy as YAML" in the YAML pane is how
// changes flow back into the repo, on the user's schedule.
//
// This keeps the original "config over UI" property that mattered — one
// declarative document, recoverable from git in a pinch — without the
// two-sources-of-truth overlay/drift machinery a layered design would need.

const KV_CONFIG_KEY = "config_yaml";

export interface SourceConfig {
  id: string;
  name: string;
  type: "rss" | "bluesky" | "podcast";
  category: string;
  url?: string;
  poll_interval_minutes?: number;
  /** Skipped by the crawl; items are kept (unlike deletion, which prunes them). */
  paused?: boolean;
  mode?: "timeline" | "account" | "feed";
  handle?: string;
  feed_uri?: string;
  apple_id?: string;
}

// The `algorithm:` block in feeds.yml. Every field is optional — absent
// fields fall back to ALGORITHM_DEFAULTS below, which are the values that
// used to be hardcoded in lib/queries.ts. A config with no algorithm block
// behaves exactly as before the block existed.
export interface AlgorithmConfig {
  /** Per-category interleave priority. 0 removes the category from the All view. */
  priority?: Record<string, number>;
  /** 1 bluesky post per N RSS items in the All view. */
  bsky_ratio?: number;
  /** Unread bluesky posts kept; older ones are hard-deleted each crawl. */
  bsky_window?: number;
  /** Recency bias of the bluesky surprise sample. 0 = uniform random. */
  surprise?: number;
  /** Oversampling multiplier for the surprise pool. */
  surprise_pool?: number;
  /** Jitter on the stride interleave. 0 = mechanical cadence. */
  jitter?: number;
  /** Unread RSS shelf life in days — one number, or a per-category map. */
  ttl_days?: number | Record<string, number>;
  /** Days before silently-dismissed items are hard-deleted. */
  retention_days?: number;
}

export interface AppConfig {
  app: {
    name: string;
    port: number;
    poll_interval_minutes: number;
    items_per_page: number;
    retention_days: number;
  };
  algorithm?: AlgorithmConfig;
  sources: SourceConfig[];
}

// RSS-fed categories (everything that is not bluesky). Also the key set for
// ttl_days per-category overrides.
export const RSS_CATEGORIES = [
  "music",
  "books",
  "film",
  "tech_review",
  "podcasts",
  "reading",
] as const;

export const ALL_CATEGORIES = [...RSS_CATEGORIES, "bluesky"] as const;

// Fully-resolved algorithm knobs — what queries.ts actually consumes.
export interface ResolvedAlgorithm {
  priority: Record<string, number>;
  bskyRatio: number;
  bskyWindow: number;
  surprise: number;
  surprisePool: number;
  jitter: number;
  /** Per-RSS-category unread TTL in hours. */
  ttlHours: Record<string, number>;
  retentionHours: number;
}

export const ALGORITHM_DEFAULTS: ResolvedAlgorithm = {
  priority: {
    music: 4,
    books: 4,
    film: 4,
    tech_review: 4,
    podcasts: 3,
    reading: 2,
    bluesky: 1,
  },
  bskyRatio: 4,
  bskyWindow: 100,
  surprise: 3,
  surprisePool: 1.5,
  jitter: 0.35,
  ttlHours: {
    music: 168,
    books: 168,
    film: 168,
    tech_review: 168,
    podcasts: 168,
    reading: 168,
  },
  retentionHours: 168,
};

let cachedConfig: AppConfig | null = null;

export function invalidateConfig(): void {
  cachedConfig = null;
}

function repoConfigPath(): string {
  const configPath = path.join(process.cwd(), "config", "feeds.yml");
  if (fs.existsSync(configPath)) return configPath;
  return path.join(process.cwd(), "config", "feeds.example.yml");
}

export function readRepoConfigYaml(): string {
  const p = repoConfigPath();
  if (!fs.existsSync(p)) {
    throw new Error(
      `Config file not found: ${p}. Copy config/feeds.example.yml to config/feeds.yml to get started.`
    );
  }
  return fs.readFileSync(p, "utf-8");
}

function readDbConfigYaml(): string | null {
  try {
    const row = getDb()
      .prepare(`SELECT value FROM kv WHERE key = ?`)
      .get(KV_CONFIG_KEY) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    // DB not available (e.g. a build-time import) — fall through to the file.
    return null;
  }
}

/** Where the live config currently comes from. */
export function getConfigSource(): "db" | "repo" {
  return readDbConfigYaml() !== null ? "db" : "repo";
}

/** The live config's raw YAML text (DB copy if present, else the repo file). */
export function getConfigYaml(): string {
  return readDbConfigYaml() ?? readRepoConfigYaml();
}

export function getConfig(): AppConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const dbYaml = readDbConfigYaml();
  if (dbYaml !== null) {
    const { config, errors } = parseConfigYaml(dbYaml);
    if (config && errors.length === 0) {
      cachedConfig = config;
      return cachedConfig;
    }
    // A corrupt DB copy must not brick the app — log and fall back to the
    // repo file. The Tune UI validates on save, so this is belt-and-braces.
    console.error(
      `[config] Stored config is invalid (${errors.join("; ")}) — falling back to repo file`
    );
  }

  const { config, errors } = parseConfigYaml(readRepoConfigYaml());
  if (!config || errors.length > 0) {
    throw new Error(`Invalid config: ${errors.join("; ")}`);
  }
  cachedConfig = config;
  return cachedConfig;
}

/** Validate and persist new config YAML as the live (DB) copy. */
export function saveConfigYaml(yamlText: string): { errors: string[] } {
  const { errors } = parseConfigYaml(yamlText);
  if (errors.length > 0) return { errors };
  getDb()
    .prepare(
      `INSERT INTO kv (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(KV_CONFIG_KEY, yamlText);
  invalidateConfig();
  return { errors: [] };
}

/** Drop the DB copy so the repo file becomes live again. */
export function resetConfigToRepo(): void {
  getDb().prepare(`DELETE FROM kv WHERE key = ?`).run(KV_CONFIG_KEY);
  invalidateConfig();
}

/** Serialize a config object to YAML (used when the UI edits structured config). */
export function dumpConfigYaml(config: AppConfig): string {
  return yaml.dump(config, { lineWidth: -1, noRefs: true });
}

/** Resolve the algorithm block over defaults. */
export function getAlgorithm(): ResolvedAlgorithm {
  return resolveAlgorithm(getConfig().algorithm);
}

export function resolveAlgorithm(a: AlgorithmConfig | undefined): ResolvedAlgorithm {
  const d = ALGORITHM_DEFAULTS;
  if (!a) return d;

  const ttlHours: Record<string, number> = { ...d.ttlHours };
  if (typeof a.ttl_days === "number") {
    for (const cat of RSS_CATEGORIES) ttlHours[cat] = a.ttl_days * 24;
  } else if (a.ttl_days && typeof a.ttl_days === "object") {
    const fallback = typeof a.ttl_days.default === "number" ? a.ttl_days.default * 24 : null;
    for (const cat of RSS_CATEGORIES) {
      const v = a.ttl_days[cat];
      if (typeof v === "number") ttlHours[cat] = v * 24;
      else if (fallback !== null) ttlHours[cat] = fallback;
    }
  }

  return {
    priority: { ...d.priority, ...(a.priority ?? {}) },
    bskyRatio: a.bsky_ratio ?? d.bskyRatio,
    bskyWindow: a.bsky_window ?? d.bskyWindow,
    surprise: a.surprise ?? d.surprise,
    surprisePool: a.surprise_pool ?? d.surprisePool,
    jitter: a.jitter ?? d.jitter,
    ttlHours,
    retentionHours: (a.retention_days ?? d.retentionHours / 24) * 24,
  };
}

// ── Validation ──────────────────────────────────────────────────────────────

const SOURCE_TYPES = new Set(["rss", "podcast", "bluesky"]);
const BLUESKY_MODES = new Set(["timeline", "account", "feed"]);
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Parse + validate config YAML. Returns the parsed config when it is usable
 * and the list of validation errors (empty = valid). Structural errors that
 * make the document unusable return config: null.
 */
export function parseConfigYaml(yamlText: string): {
  config: AppConfig | null;
  errors: string[];
} {
  const errors: string[] = [];
  let raw: unknown;
  try {
    raw = yaml.load(yamlText);
  } catch (err) {
    return {
      config: null,
      errors: [`YAML parse error: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { config: null, errors: ["Config must be a YAML mapping with app/sources keys"] };
  }
  const doc = raw as Record<string, unknown>;

  // app block — lenient, with defaults filled in
  const appRaw = (doc.app && typeof doc.app === "object" ? doc.app : {}) as Record<string, unknown>;
  const app = {
    name: typeof appRaw.name === "string" ? appRaw.name : "The Feed",
    port: isFiniteNumber(appRaw.port) ? appRaw.port : 3000,
    poll_interval_minutes: isFiniteNumber(appRaw.poll_interval_minutes)
      ? appRaw.poll_interval_minutes
      : 15,
    items_per_page: isFiniteNumber(appRaw.items_per_page) ? appRaw.items_per_page : 50,
    retention_days: isFiniteNumber(appRaw.retention_days) ? appRaw.retention_days : 30,
  };
  if (app.poll_interval_minutes < 1) errors.push("app.poll_interval_minutes must be ≥ 1");

  // sources
  if (!Array.isArray(doc.sources)) {
    return { config: null, errors: [...errors, "sources must be a list"] };
  }
  const seenIds = new Set<string>();
  const sources: SourceConfig[] = [];
  (doc.sources as unknown[]).forEach((entry, i) => {
    const label = `sources[${i}]`;
    if (!entry || typeof entry !== "object") {
      errors.push(`${label}: must be a mapping`);
      return;
    }
    const s = entry as Record<string, unknown>;
    const id = typeof s.id === "string" ? s.id : "";
    if (!id || !ID_PATTERN.test(id)) {
      errors.push(`${label}: id must be a lowercase slug (a-z, 0-9, -, _)`);
    } else if (seenIds.has(id)) {
      errors.push(`${label}: duplicate id "${id}"`);
    }
    seenIds.add(id);
    const idLabel = id ? `source "${id}"` : label;

    if (typeof s.name !== "string" || !s.name.trim()) errors.push(`${idLabel}: name is required`);
    const type = typeof s.type === "string" ? s.type : "";
    if (!SOURCE_TYPES.has(type)) {
      errors.push(`${idLabel}: type must be rss, podcast, or bluesky`);
    }
    if (typeof s.category !== "string" || !s.category.trim()) {
      errors.push(`${idLabel}: category is required`);
    }
    if (type === "rss" || type === "podcast") {
      const url = typeof s.url === "string" ? s.url : "";
      if (!/^https?:\/\//.test(url)) errors.push(`${idLabel}: url must be an http(s) URL`);
    }
    if (type === "bluesky") {
      const mode = typeof s.mode === "string" ? s.mode : "";
      if (!BLUESKY_MODES.has(mode)) {
        errors.push(`${idLabel}: bluesky sources need mode: timeline, account, or feed`);
      } else if (mode === "account" && (typeof s.handle !== "string" || !s.handle)) {
        errors.push(`${idLabel}: mode account needs a handle`);
      } else if (mode === "feed" && !(typeof s.feed_uri === "string" && s.feed_uri.startsWith("at://"))) {
        errors.push(`${idLabel}: mode feed needs an at:// feed_uri`);
      }
    }
    if (s.poll_interval_minutes !== undefined && (!isFiniteNumber(s.poll_interval_minutes) || s.poll_interval_minutes < 1)) {
      errors.push(`${idLabel}: poll_interval_minutes must be a number ≥ 1`);
    }
    if (s.paused !== undefined && typeof s.paused !== "boolean") {
      errors.push(`${idLabel}: paused must be true or false`);
    }
    sources.push(s as unknown as SourceConfig);
  });

  // algorithm block
  const algo = doc.algorithm as AlgorithmConfig | undefined;
  if (algo !== undefined) {
    if (!algo || typeof algo !== "object" || Array.isArray(algo)) {
      errors.push("algorithm must be a mapping");
    } else {
      const numRules: Array<[keyof AlgorithmConfig, number, number]> = [
        ["bsky_ratio", 1, 50],
        ["bsky_window", 10, 2000],
        ["surprise", 0, 20],
        ["surprise_pool", 1, 10],
        ["jitter", 0, 1],
        ["retention_days", 1, 365],
      ];
      for (const [key, min, max] of numRules) {
        const v = algo[key];
        if (v !== undefined && (!isFiniteNumber(v) || v < min || v > max)) {
          errors.push(`algorithm.${key} must be a number between ${min} and ${max}`);
        }
      }
      if (algo.priority !== undefined) {
        if (!algo.priority || typeof algo.priority !== "object") {
          errors.push("algorithm.priority must be a map of category → number");
        } else {
          for (const [cat, v] of Object.entries(algo.priority)) {
            if (!isFiniteNumber(v) || v < 0 || v > 9) {
              errors.push(`algorithm.priority.${cat} must be a number between 0 and 9`);
            }
          }
        }
      }
      if (algo.ttl_days !== undefined) {
        if (isFiniteNumber(algo.ttl_days)) {
          if (algo.ttl_days < 0.5 || algo.ttl_days > 90) {
            errors.push("algorithm.ttl_days must be between 0.5 and 90");
          }
        } else if (algo.ttl_days && typeof algo.ttl_days === "object") {
          for (const [cat, v] of Object.entries(algo.ttl_days)) {
            if (!isFiniteNumber(v) || v < 0.5 || v > 90) {
              errors.push(`algorithm.ttl_days.${cat} must be between 0.5 and 90`);
            }
          }
        } else {
          errors.push("algorithm.ttl_days must be a number or a map of category → days");
        }
      }
    }
  }

  const config: AppConfig = {
    app,
    algorithm: algo,
    sources,
  };
  return { config, errors };
}
