import type { Metadata } from "next";
import Link from "next/link";
import { getDiscworldProgress } from "@/lib/books/discworldData";
import DiscworldMap from "@/components/DiscworldMap";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Discworld — hub" };

export default function DiscworldPage() {
  const progress = getDiscworldProgress();

  return (
    <article className="mx-auto max-w-[1100px] px-4 pb-24 pt-6 sm:px-6">
      <header className="mb-5">
        <p className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer">
          Books · Reading order
        </p>
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="mt-1 font-display text-2xl text-cream">Discworld</h1>
          <Link
            href="/books"
            className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dim hover:text-accent"
          >
            ← Library
          </Link>
        </div>
        <p className="mt-1 text-sm text-cream-dim">
          The reading order guide, tracked. Books you finish on the X3 or in Readest fill in on
          their own; anything you read before the hub existed — or on paper — you mark yourself.
        </p>
      </header>

      <DiscworldMap
        states={progress.states}
        novels={progress.novels}
        all={progress.all}
        unmatched={progress.unmatched.map((b) => ({ id: b.id, title: b.title }))}
      />

      <footer className="mt-6 border-t border-rule/40 pt-4 text-[0.78rem] leading-relaxed text-cream-dimmer">
        <p>
          Layout after &ldquo;The Discworld Reading Order Guide 3.0&rdquo; — original guide by
          Krzysztof Kietzman, graphic design by Jakub Oleksów, updated by Andrés Peña and Emmanuel
          Varet. In memory of Terry Pratchett, 1948–2015.
        </p>
        <p className="mt-2">
          A book counts as read when your device syncs past 97% of it, which is the same threshold
          the reading stats use — readers stop short of the last page. A mark you make by hand
          always wins over the sync, and clearing it hands the book back.
        </p>
      </footer>
    </article>
  );
}
