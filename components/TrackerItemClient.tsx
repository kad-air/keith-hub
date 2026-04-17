"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { TrackerConfig, TrackerItem } from "@/lib/craft-types";
import type { ExtraProp } from "@/lib/tracker-detail";
import { getExternalLinkLabel } from "@/lib/tracker-detail";
import Toast from "@/components/Toast";

interface Props {
  item: TrackerItem;
  config: TrackerConfig;
  extraProps: ExtraProp[];
}

function formatReleaseDate(releaseDate: string | null): string | null {
  if (!releaseDate) return null;
  if (/^\d{4}$/.test(releaseDate)) return releaseDate;
  const d = new Date(releaseDate);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatPropValue(prop: ExtraProp): React.ReactNode {
  switch (prop.type) {
    case "date": {
      if (typeof prop.value !== "string") return String(prop.value);
      return formatReleaseDate(prop.value) ?? prop.value;
    }
    case "boolean":
      // Only true booleans make it through buildExtraProps.
      return "Yes";
    case "multiSelect": {
      const values = Array.isArray(prop.value)
        ? prop.value
        : [String(prop.value)];
      return (
        <span className="inline-flex flex-wrap gap-1.5">
          {values.map((v) => (
            <span
              key={v}
              className="border border-rule/60 px-1.5 py-0.5 font-mono text-[0.66rem] uppercase tracking-kicker text-cream-dim"
            >
              {v}
            </span>
          ))}
        </span>
      );
    }
    case "singleSelect":
      return (
        <span className="border border-rule/60 px-1.5 py-0.5 font-mono text-[0.66rem] uppercase tracking-kicker text-cream-dim">
          {String(prop.value)}
        </span>
      );
    case "number":
    case "text":
    default:
      return String(prop.value);
  }
}

export default function TrackerItemClient({
  item,
  config,
  extraProps,
}: Props) {
  const [imageFailed, setImageFailed] = useState(false);
  const [status, setStatus] = useState(item.status);
  const [rating, setRating] = useState(item.rating);
  const [rankingDraft, setRankingDraft] = useState(
    item.ranking?.toString() ?? "",
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setImageFailed(false);
  }, [item.imageUrl]);

  const commit = useCallback(
    async (
      updates: Partial<Pick<TrackerItem, "status" | "rating" | "ranking">>,
    ) => {
      try {
        const res = await fetch(
          `/api/trackers/${config.slug}/${item.id}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(updates),
          },
        );
        if (!res.ok) throw new Error("Update failed");
      } catch {
        setError("Update failed — reverted");
        // Revert local state to the server-provided values
        setStatus(item.status);
        setRating(item.rating);
        setRankingDraft(item.ranking?.toString() ?? "");
      }
    },
    [config.slug, item.id, item.status, item.rating, item.ranking],
  );

  const handleStatusChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const next = e.target.value;
      setStatus(next);
      void commit({ status: next });
    },
    [commit],
  );

  const handleRatingChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const next = e.target.value;
      setRating(next);
      void commit({ rating: next });
    },
    [commit],
  );

  const handleRankingCommit = useCallback(() => {
    const value = rankingDraft.trim();
    const parsed = value === "" ? undefined : parseInt(value, 10);
    const next =
      parsed !== undefined && !isNaN(parsed) ? parsed : undefined;
    if (next === item.ranking) return;
    void commit({ ranking: next });
  }, [commit, rankingDraft, item.ranking]);

  const handleRankingKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      (e.target as HTMLInputElement).blur();
    }
  }, []);

  // iOS PWA quirk: window.open() produces both a Safari tab and an in-app
  // overlay. A programmatic <a target="_blank"> click is the clean handoff
  // — same pattern as FeedClient.handleOpen.
  const handleExternalOpen = useCallback(() => {
    if (!item.linkUrl) return;
    const a = document.createElement("a");
    a.href = item.linkUrl;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [item.linkUrl]);

  const formattedDate = formatReleaseDate(item.releaseDate);
  const ctaLabel = item.linkUrl ? getExternalLinkLabel(item.linkUrl) : null;

  return (
    <article className="mx-auto max-w-[640px] px-[max(1rem,env(safe-area-inset-left))] pb-[max(2rem,env(safe-area-inset-bottom))] pt-5">
      {/* Back link */}
      <div className="mb-5">
        <Link
          href={`/trackers/${config.slug}`}
          className={[
            "inline-flex items-baseline gap-1.5 font-mono text-[0.68rem] uppercase tracking-kicker transition-colors",
            "text-cream-dim hover:text-cream",
          ].join(" ")}
        >
          <span aria-hidden>←</span>
          <span>{config.label}</span>
        </Link>
      </div>

      {/* Cover */}
      <div
        className={[
          config.aspectClass,
          "relative mx-auto w-full max-w-[360px] overflow-hidden border border-rule/40 bg-ink",
        ].join(" ")}
      >
        {item.imageUrl && !imageFailed ? (
          <img
            src={item.imageUrl}
            alt={item.name}
            onError={() => setImageFailed(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          <div
            className={[
              "flex h-full w-full items-center justify-center p-6",
              config.colorClass,
              "bg-ink-hover",
            ].join(" ")}
          >
            <span className="text-center font-display text-xl italic leading-tight opacity-60">
              {item.name}
            </span>
          </div>
        )}
      </div>

      {/* Title block */}
      <header className="mt-6">
        <div
          className={[
            "font-mono text-[0.65rem] uppercase tracking-kicker",
            config.colorClass,
          ].join(" ")}
        >
          {config.label}
        </div>
        <h1 className="mt-2 font-display text-[1.9rem] font-medium italic leading-[1.1] text-cream">
          {item.name}
        </h1>
        {item.subtitle && (
          <p className="mt-1.5 font-mono text-[0.75rem] uppercase tracking-kicker text-cream-dim">
            {item.subtitle}
          </p>
        )}
        {formattedDate && (
          <p className="mt-1 font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer">
            {formattedDate}
          </p>
        )}
      </header>

      {/* External CTA */}
      {ctaLabel && (
        <div className="mt-5">
          <button
            type="button"
            onClick={handleExternalOpen}
            className={[
              "inline-flex items-baseline gap-2 border px-4 py-2.5 font-mono text-[0.72rem] uppercase tracking-kicker transition-colors",
              "border-accent/70 text-accent hover:bg-accent/10",
            ].join(" ")}
          >
            <span>{ctaLabel}</span>
            <span aria-hidden>→</span>
          </button>
        </div>
      )}

      {/* Edit controls */}
      <section className="mt-7 border-y border-rule/40 py-4">
        <div className="grid grid-cols-[1fr_auto_auto] items-center gap-2.5">
          <label className="contents">
            <span className="sr-only">Status</span>
            <select
              value={status}
              onChange={handleStatusChange}
              className="min-w-0 appearance-none border border-rule bg-ink px-2 py-1.5 font-mono text-[0.72rem] uppercase tracking-kicker text-cream transition-colors hover:border-rule-strong focus:border-accent focus:outline-none"
            >
              <option value="">— status —</option>
              {config.statusOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr-only">Rating</span>
            <select
              value={rating}
              onChange={handleRatingChange}
              className="w-14 appearance-none border border-rule bg-ink px-1 py-1.5 text-center text-[1rem] transition-colors hover:border-rule-strong focus:border-accent focus:outline-none"
            >
              <option value="">—</option>
              {config.ratingOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr-only">Ranking</span>
            <input
              type="number"
              min={1}
              step={1}
              value={rankingDraft}
              onChange={(e) => setRankingDraft(e.target.value)}
              onBlur={handleRankingCommit}
              onKeyDown={handleRankingKeyDown}
              placeholder="#"
              className="w-14 appearance-none border border-rule bg-ink px-1 py-1.5 text-center font-mono text-[0.78rem] tabular-nums text-cream transition-colors hover:border-rule-strong focus:border-accent focus:outline-none"
            />
          </label>
        </div>
      </section>

      {/* Extra properties */}
      {extraProps.length > 0 && (
        <dl className="mt-6 flex flex-col gap-5">
          {extraProps.map((p) => {
            const isLong =
              p.type === "text" &&
              typeof p.value === "string" &&
              p.value.length > 120;
            return (
              <div key={p.key}>
                <dt className="font-mono text-[0.62rem] uppercase tracking-kicker text-cream-dimmer">
                  {p.name}
                </dt>
                <dd
                  className={[
                    "mt-1.5 text-cream",
                    isLong
                      ? "font-display text-[1rem] leading-relaxed"
                      : "font-display text-[0.95rem]",
                  ].join(" ")}
                >
                  {formatPropValue(p)}
                </dd>
              </div>
            );
          })}
        </dl>
      )}

      {error && (
        <Toast
          message={error}
          onDismiss={() => setError(null)}
          durationMs={3500}
        />
      )}
    </article>
  );
}
