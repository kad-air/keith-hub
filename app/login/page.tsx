import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "hub — log in",
};

export default function LoginPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  const hasError = searchParams.error === "1";

  return (
    <div className="flex min-h-[80vh] items-center justify-center px-6">
      <div className="w-full max-w-[280px]">
        <h1 className="mb-8 text-center font-display text-[2rem] font-medium italic leading-none tracking-tight text-cream">
          hub
        </h1>
        <form action="/api/auth/login" method="POST" className="space-y-4">
          <input
            type="password"
            name="password"
            placeholder="Password"
            autoFocus
            required
            className="w-full border border-rule bg-ink-raised px-3 py-2.5 font-display text-sm text-cream placeholder:text-cream-dimmer focus:border-accent focus:outline-none"
          />
          {hasError && (
            <p className="font-mono text-[0.65rem] uppercase tracking-kicker text-red-400">
              Wrong password.
            </p>
          )}
          <button
            type="submit"
            className="w-full border border-rule bg-ink-raised px-3 py-2.5 font-mono text-[0.65rem] uppercase tracking-kicker text-cream transition-colors hover:border-rule-strong hover:text-accent"
          >
            Log in
          </button>
        </form>
      </div>
    </div>
  );
}
