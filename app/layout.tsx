import type { Metadata, Viewport } from "next";
import { Newsreader, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";
import ThemeProvider from "@/components/ThemeProvider";
import Masthead from "@/components/Masthead";

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
  title: "hub",
  description: "Personal content hub for intentional media consumption.",
  applicationName: "hub",
  // NOTE: manifest is NOT set here. Next.js 14.2.3 hardcodes
  // crossOrigin="use-credentials" on the metadata-generated <link rel="manifest">
  // (see node_modules/next/dist/lib/metadata/generate/basic.js), which causes
  // iOS Safari to silently fail to fetch the manifest — meaning Add to Home
  // Screen produces a regular bookmark instead of a real PWA install. We emit
  // the link manually in the JSX below to avoid the broken attribute.
  appleWebApp: {
    capable: true,
    title: "hub",
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
            __html: `(function(){try{var t=localStorage.getItem("hub-theme");if(t&&["light","dark","auto"].indexOf(t)!==-1){document.documentElement.setAttribute("data-theme",t)}}catch(e){}})()`,
          }}
        />
      </head>
      <body className="font-display text-cream bg-ink min-h-screen">
        <ThemeProvider>
          <Masthead />
          <main className="relative z-10">{children}</main>
          <ServiceWorkerRegister />
        </ThemeProvider>
      </body>
    </html>
  );
}
