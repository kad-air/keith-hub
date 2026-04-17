// Matches TrackerItemClient's layout shell so the page doesn't jump when
// real data swaps in. loading.tsx doesn't receive route params, so the
// cover uses a generic 2/3 aspect (matches most trackers).

export default function TrackerItemLoading() {
  return (
    <article className="mx-auto max-w-[640px] px-[max(1rem,env(safe-area-inset-left))] pb-[max(2rem,env(safe-area-inset-bottom))] pt-5">
      <div className="mb-5 h-3 w-24 animate-pulse rounded-sm bg-rule/30" />
      <div className="mx-auto aspect-[2/3] w-full max-w-[360px] animate-pulse border border-rule/40 bg-rule/20" />
      <div className="mt-6 space-y-2.5">
        <div className="h-3 w-16 animate-pulse rounded-sm bg-rule/30" />
        <div className="h-8 w-3/4 animate-pulse rounded-sm bg-rule/30" />
        <div className="h-3 w-1/2 animate-pulse rounded-sm bg-rule/25" />
      </div>
      <div className="mt-7 border-y border-rule/40 py-4">
        <div className="flex gap-2.5">
          <div className="h-9 flex-1 animate-pulse rounded-sm bg-rule/25" />
          <div className="h-9 w-14 animate-pulse rounded-sm bg-rule/25" />
          <div className="h-9 w-14 animate-pulse rounded-sm bg-rule/25" />
        </div>
      </div>
    </article>
  );
}
