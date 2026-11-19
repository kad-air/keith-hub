import type { Metadata } from "next";
import GuestChrome from "@/components/christmas/GuestChrome";

export const metadata: Metadata = {
  title: "Christmas — hub",
};

const MESSAGES: Record<string, string> = {
  "1": "That passcode isn't right.",
  wait: "Too many tries. Wait a few minutes and try again.",
  off: "The list isn't set up for a passcode yet.",
};

// Same shape as the hub's own /login, in the section's colours.
export default function ChristmasLogin({ searchParams }: { searchParams: { error?: string } }) {
  const error = searchParams.error ? MESSAGES[searchParams.error] ?? MESSAGES["1"] : null;
  return (
    <div className="xmas-page flex min-h-[80vh] items-center justify-center px-6">
      <GuestChrome />
      <form action="/api/christmas/auth" method="POST" className="w-full max-w-[300px] space-y-4">
        <p className="text-center font-mono text-[0.62rem] uppercase tracking-kicker text-cat-xmas">✶ The Adairs ✶</p>
        <h1 className="text-center font-display text-[2.2rem] italic leading-none tracking-tight text-cream">
          Christmas<span className="text-accent">.</span>
        </h1>
        <p className="pb-2 text-center font-display text-[0.95rem] italic text-cream-dim">
          Enter the family passcode. You&apos;ll only need it once on this device.
        </p>
        <input
          type="password"
          name="passcode"
          placeholder="Passcode"
          aria-label="Passcode"
          autoComplete="current-password"
          autoFocus
          required
          className="w-full border border-rule bg-ink-raised px-3 py-2.5 font-display text-base text-cream placeholder:text-cream-dimmer focus:border-accent focus:outline-none"
        />
        {error && <p className="font-mono text-[0.65rem] uppercase tracking-kicker text-accent">{error}</p>}
        <button
          type="submit"
          className="w-full border border-cat-xmas/60 bg-ink-raised px-3 py-2.5 font-mono text-[0.65rem] uppercase tracking-kicker text-cat-xmas transition-colors hover:border-cat-xmas hover:text-cream"
        >
          Open the list
        </button>
      </form>
    </div>
  );
}
