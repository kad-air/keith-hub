// Shown instantly while the server component awaits the Craft API.
// Matches TrackerClient's layout (sticky sub-nav + 2/3-col grid) so the page
// doesn't jump when real data swaps in. loading.tsx doesn't receive route
// params, so the card aspect is generic (matches books/tv/movies).

const SKELETON_CARDS = 12;

export default function TrackerLoading() {
  return (
    <article className="mx-auto max-w-[720px] px-[max(1rem,env(safe-area-inset-left))] pb-[max(2rem,env(safe-area-inset-bottom))]">
      {/* Sub-nav placeholder */}
      <div className="sticky top-14 z-30 -mx-[max(1rem,env(safe-area-inset-left))] border-b border-rule/40 bg-ink/85 px-[max(1rem,env(safe-area-inset-left))] pt-3 pb-0 backdrop-blur-md">
        <div className="flex items-end gap-2">
          <div className="flex min-w-0 flex-1 gap-4 overflow-hidden">
            {[40, 56, 48, 52].map((w, i) => (
              <div
                key={i}
                className="mb-2.5 h-3 shrink-0 animate-pulse rounded-sm bg-rule/40"
                style={{ width: `${w}px` }}
              />
            ))}
          </div>
          <div className="mb-1.5 h-6 w-20 shrink-0 animate-pulse rounded-sm bg-rule/30" />
        </div>
      </div>

      {/* Grid placeholder */}
      <div className="grid grid-cols-2 gap-3 pt-4 sm:grid-cols-3">
        {Array.from({ length: SKELETON_CARDS }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <div className="aspect-[2/3] w-full animate-pulse rounded-sm bg-rule/25" />
            <div className="h-3 w-4/5 animate-pulse rounded-sm bg-rule/30" />
            <div className="h-2.5 w-3/5 animate-pulse rounded-sm bg-rule/20" />
          </div>
        ))}
      </div>
    </article>
  );
}
