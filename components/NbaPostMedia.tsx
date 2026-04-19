"use client";

import type { PostMedia } from "@/lib/reddit-types";

interface Props {
  media: PostMedia;
  permalink: string;
}

function aspectStyle(w: number, h: number): React.CSSProperties {
  if (!w || !h) return {};
  return { aspectRatio: `${w} / ${h}` };
}

export default function NbaPostMedia({ media, permalink }: Props) {
  if (media.kind === "none") return null;

  if (media.kind === "image") {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={media.url}
        alt={media.alt ?? ""}
        width={media.width || undefined}
        height={media.height || undefined}
        loading="lazy"
        className="w-full rounded-sm border border-rule/40 bg-ink/60"
      />
    );
  }

  if (media.kind === "gallery") {
    return (
      <div>
        <div className="flex snap-x snap-mandatory gap-2 overflow-x-auto pb-2">
          {media.images.map((img, i) => (
            <div
              key={i}
              className="relative shrink-0 snap-center overflow-hidden rounded-sm border border-rule/40 bg-ink/60"
              style={{
                width: "100%",
                maxWidth: "100%",
                ...aspectStyle(img.width, img.height),
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.url}
                alt={img.alt ?? ""}
                loading={i === 0 ? "eager" : "lazy"}
                className="h-full w-full object-contain"
              />
            </div>
          ))}
        </div>
        <p className="mt-1 font-mono text-[0.68rem] uppercase tracking-kicker text-cream-dimmer">
          {media.images.length} images · swipe
        </p>
      </div>
    );
  }

  if (media.kind === "reddit_video") {
    // iOS Safari plays HLS natively. Desktop Chrome/Firefox fall back to the
    // silent MP4; good enough for personal use. If audio-on-desktop ever
    // matters, swap in hls.js.
    return (
      <div
        className="overflow-hidden rounded-sm border border-rule/40 bg-black"
        style={aspectStyle(media.width, media.height)}
      >
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          className="h-full w-full"
          controls
          playsInline
          preload="metadata"
          src={media.hls_url || media.fallback_url}
        >
          {media.fallback_url && <source src={media.fallback_url} type="video/mp4" />}
        </video>
      </div>
    );
  }

  if (media.kind === "gif_video") {
    return (
      <div
        className="overflow-hidden rounded-sm border border-rule/40 bg-black"
        style={aspectStyle(media.width, media.height)}
      >
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          className="h-full w-full"
          autoPlay
          muted
          loop
          playsInline
          src={media.mp4_url}
        />
      </div>
    );
  }

  if (media.kind === "youtube") {
    return (
      <div
        className="overflow-hidden rounded-sm border border-rule/40 bg-black"
        style={{ aspectRatio: "16 / 9" }}
      >
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${media.video_id}`}
          title="YouTube video"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
          className="h-full w-full border-0"
        />
      </div>
    );
  }

  if (media.kind === "external") {
    return (
      <a
        href={media.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex overflow-hidden rounded-sm border border-rule bg-ink/60 transition-colors hover:border-rule-strong"
      >
        {media.thumb && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={media.thumb}
            alt=""
            loading="lazy"
            className="h-24 w-24 flex-shrink-0 object-cover sm:h-28 sm:w-28"
          />
        )}
        <div className="min-w-0 flex-1 px-3.5 py-2.5">
          <div className="font-mono text-[0.68rem] uppercase tracking-kicker text-cream-dim">
            {media.domain}
          </div>
          {media.title && (
            <div className="mt-1 line-clamp-2 font-display text-[0.95rem] font-medium leading-snug text-cream">
              {media.title}
            </div>
          )}
          <div className="mt-1 font-mono text-[0.68rem] uppercase tracking-kicker text-cream-dimmer">
            Open link ↗
          </div>
        </div>
      </a>
    );
  }

  // Exhaustiveness guard
  const _exhaustive: never = media;
  void _exhaustive;
  void permalink;
  return null;
}
