import type { Metadata } from "next";
import GuestChrome from "@/components/christmas/GuestChrome";

export const metadata: Metadata = {
  title: "Adair Christmas 2026",
};

const MESSAGES: Record<string, string> = {
  "1": "That passcode isn't right.",
  wait: "Too many tries. Wait a few minutes and try again.",
  off: "The list isn't set up for a passcode yet.",
};

export default function ChristmasLogin({ searchParams }: { searchParams: { error?: string } }) {
  const error = searchParams.error ? MESSAGES[searchParams.error] ?? MESSAGES["1"] : null;
  return (
    <>
      <GuestChrome />
      <form className="gate" action="/api/christmas/auth" method="POST">
        <h1>Adair Christmas 2026</h1>
        <p>Enter the family passcode. You&apos;ll only need it once on this device.</p>
        <input
          type="password"
          name="passcode"
          placeholder="Passcode"
          aria-label="Passcode"
          autoComplete="current-password"
          autoFocus
          required
        />
        {error && <p className="bad">{error}</p>}
        <button className="btn" type="submit">
          Open the list
        </button>
      </form>
    </>
  );
}
