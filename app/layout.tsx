import type { Metadata, Viewport } from "next";
import { Newsreader, JetBrains_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";
import ThemeProvider from "@/components/ThemeProvider";
import AppMenu from "@/components/AppMenu";

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
  applicationName: "The Feed",
  // NOTE: manifest is NOT set here. Next.js 14.2.3 hardcodes
  // crossOrigin="use-credentials" on the metadata-generated <link rel="manifest">
  // (see node_modules/next/dist/lib/metadata/generate/basic.js), which causes
  // iOS Safari to silently fail to fetch the manifest — meaning Add to Home
  // Screen produces a regular bookmark instead of a real PWA install. We emit
  // the link manually in the JSX below to avoid the broken attribute.
  appleWebApp: {
    capable: true,
    title: "Feed",
    statusBarStyle: "black-translucent",
  },
  formatDetection: {
    telephone: false,
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: { url: "/icons/apple-touch-icon.png", sizes: "180x180" },
    shortcut: "/icons/favicon-32.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#0c0a08",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  userScalable: false,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      data-theme="auto"
      className={`${displayFont.variable} ${monoFont.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Manual manifest link — see comment on metadata above for why this
            is hand-rolled instead of using metadata.manifest. */}
        <link rel="manifest" href="/manifest.webmanifest" />
        {/* Blocking script: apply saved theme before first paint to avoid
            a flash of the wrong theme. Must run before React hydrates. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("the-feed-theme");if(t&&["light","dark","auto"].indexOf(t)!==-1){document.documentElement.setAttribute("data-theme",t)}}catch(e){}})()`,
          }}
        />
      </head>
      <body className="font-display text-cream bg-ink min-h-screen">
        <ThemeProvider>
        <header className="sticky top-0 z-40 border-b border-rule/60 bg-ink/85 backdrop-blur-md pt-[env(safe-area-inset-top)]">
          <div className="mx-auto flex min-h-14 max-w-[720px] items-center justify-between pl-[max(1.5rem,env(safe-area-inset-left))] pr-[max(1.5rem,env(safe-area-inset-right))]">
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
              <Link
                href="/read"
                className="font-mono text-[0.68rem] uppercase tracking-kicker text-cream-dim transition-colors hover:text-cream"
              >
                Read
              </Link>
              <AppMenu />
            </nav>
          </div>
        </header>
        <main className="relative z-10">{children}</main>
        <ServiceWorkerRegister />
        </ThemeProvider>
      </body>
    </html>
  );
}
