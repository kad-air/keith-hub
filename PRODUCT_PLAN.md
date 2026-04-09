# The Feed — Product Plan

> A personal content hub for intentional media consumption.
> Self-hosted. Tailscale-only. Fast. Beautiful. Anti-doom-scroll.

---

## 1. Vision

**The Feed** is a single place to see everything new across the content sources that matter to you — blogs, Bluesky, podcasts, music, movies — and then hand off to the right native app for actual consumption. It's a triage layer, not a media player. It replaces the compulsive Reddit/Twitter check with something finite and deliberate.

### Design Principles

1. **Finite, not infinite.** No infinite scroll. You reach the end. You're done. You close it and go live your life.
2. **Triage, not consumption.** Scan, save, dismiss. The app surfaces what's new; native apps handle playback/reading.
3. **Config over UI.** Sources are managed in a YAML config file in the repo. Claude Code is the admin panel.
4. **Speed is a feature.** Sub-second loads. No spinners. No layout shift. Server-rendered where it counts.
5. **Beauty is a feature.** This replaces Reddit. It needs to feel *good* — like opening a well-designed magazine, not a dashboard.
6. **One person, one purpose.** No auth system, no multi-user, no sharing. It's your personal tool behind your personal Tailscale network.

---

## 2. Architecture

Next.js 14+ (App Router) + SQLite (better-sqlite3) + Tailwind CSS. Mac Mini deployment via PM2. Auto-deploy via cron pulling from GitHub main.

---

## 3. Content Sources (v1)

- RSS / Blogs
- Bluesky (AT Protocol)
- Podcasts (RSS with apple_podcasts handoff)
- Music (RSS-based for v1)
- Movies/Film (RSS + Letterboxd)

---

## 4. Milestones

### v0 — Skeleton ✓ (current)
- Next.js scaffold, SQLite schema, config parser, RSS fetcher, unified feed view, dark mode, PM2 config

### v1 — Daily Driver
- Bluesky integration, podcast support, save-for-later, mark as read, category filters, finite scroll, pull-to-refresh, keyboard shortcuts, auto-deploy pipeline

### v2 — Refined
- Saved items view, consumption log, Craft integration, TMDB enrichment, muted keywords, PWA manifest

---

*Last updated: April 2026*
*Author: Keith + Claude*
