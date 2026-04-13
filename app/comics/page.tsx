import type { Metadata } from "next";
import Link from "next/link";
import { STORYLINES } from "@/lib/comics-data";
import { getReadComicIds } from "@/lib/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Comics — hub" };

export default function ComicsIndexPage() {
  const readIds = getReadComicIds();

  return (
    <article className="mx-auto max-w-[720px] px-4 pb-24 pt-6 sm:px-6">
      <header className="mb-6">
        <p className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dimmer">
          Section
        </p>
        <h1 className="mt-1 font-display text-2xl text-cream">Comics</h1>
        <p className="mt-1 text-sm text-cream-dim">
          Curated reading orders for long-form comic storylines.
        </p>
      </header>

      <ul className="space-y-3">
        {STORYLINES.map((s) => {
          const total = s.issues.length;
          const read = s.issues.filter((i) => readIds.has(i.id)).length;
          return (
            <li key={s.slug}>
              <Link
                href={`/comics/${s.slug}`}
                className="block border border-rule/60 bg-ink-raised/40 px-4 py-3 transition-colors hover:border-accent/60 hover:bg-ink-raised/70"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="font-display text-lg text-cream">{s.title}</h2>
                  <span className="font-mono text-[0.7rem] uppercase tracking-kicker text-cream-dim">
                    {read} / {total}
                  </span>
                </div>
                {s.description && (
                  <p className="mt-1 text-sm text-cream-dim">{s.description}</p>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </article>
  );
}
