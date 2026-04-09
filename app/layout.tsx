import type { Metadata } from "next";
import { Newsreader, JetBrains_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const displayFont = Newsreader({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  style: ["normal", "italic"],
  variable: "--font-display",
  display: "swap",
  adjustFontFallback: false,
});

const monoFont = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "The Feed",
  description: "Personal content hub for intentional media consumption.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`dark ${displayFont.variable} ${monoFont.variable}`}
    >
      <body className="font-display text-cream bg-ink min-h-screen">
        <header className="sticky top-0 z-40 border-b border-rule/60 bg-ink/85 backdrop-blur-md">
          <div className="mx-auto flex h-14 max-w-[720px] items-center justify-between px-6">
            <Link href="/" className="group inline-flex items-baseline gap-1.5">
              <span className="font-display text-[1.4rem] font-medium italic leading-none tracking-tight text-cream transition-colors group-hover:text-accent">
                The&nbsp;Feed
              </span>
              <span
                aria-hidden
                className="hidden font-mono text-[0.6rem] uppercase tracking-kicker text-cream-dimmer sm:inline"
              >
                — est. 2026
              </span>
            </Link>
            <nav className="flex items-center gap-6">
              <Link
                href="/"
                className="font-mono text-[0.68rem] uppercase tracking-kicker text-cream-dim transition-colors hover:text-cream"
              >
                Today
              </Link>
              <Link
                href="/saved"
                className="font-mono text-[0.68rem] uppercase tracking-kicker text-cream-dim transition-colors hover:text-cream"
              >
                Saved
              </Link>
            </nav>
          </div>
        </header>
        <main className="relative z-10">{children}</main>
      </body>
    </html>
  );
}
