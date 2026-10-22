import type { Fetched } from "@/lib/hoops/scores/data";

/** Where the numbers came from and how fresh they are — and, when the
 *  upstream failed, that this is an old copy (or that there is none). */
export function SourceNote({ fetched }: { fetched: Fetched<unknown>[] }) {
  const errors = fetched.filter((f) => f.error);
  const stale = errors.filter((f) => f.stale);
  const times = fetched.map((f) => f.fetchedAt).filter((t): t is number => t != null);
  const oldest = times.length ? Math.min(...times) : null;
  const at = (ms: number) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Denver",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(ms));
  return (
    <>
      {errors.length > 0 && (
        <p className="mb-4 border border-cat-hoops/50 px-3 py-2 font-mono text-[0.68rem] text-cream-dim">
          {stale.length === errors.length
            ? `Couldn't reach ESPN (${errors[0].error}). Showing the copy from ${oldest ? at(oldest) : "earlier"} MT.`
            : `Couldn't reach ESPN (${errors[0].error}) and there's no saved copy yet. Try again in a minute.`}
        </p>
      )}
      <p className="mt-8 font-mono text-[0.58rem] uppercase tracking-kicker text-cream-dimmer">
        Live data from ESPN · times Mountain
        {oldest ? ` · updated ${at(oldest)}` : ""}
      </p>
    </>
  );
}
