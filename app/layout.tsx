import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "The Feed",
  description: "Personal content hub for intentional media consumption.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        style={{
          backgroundColor: "#0a0a0c",
          color: "#f0f0f2",
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          margin: 0,
          padding: 0,
        }}
      >
        <header
          style={{
            borderBottom: "1px solid #1e1e24",
            padding: "0 1.5rem",
            height: "52px",
            display: "flex",
            alignItems: "center",
            position: "sticky",
            top: 0,
            zIndex: 50,
            backgroundColor: "#0a0a0c",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", maxWidth: "680px" }}>
            <Link href="/" style={{ textDecoration: "none" }}>
              <span
                style={{
                  fontFamily: "Georgia, serif",
                  fontSize: "1.125rem",
                  fontWeight: 600,
                  color: "#f0f0f2",
                  letterSpacing: "-0.01em",
                }}
              >
                The Feed
              </span>
            </Link>
            <Link href="/saved" style={{ textDecoration: "none" }}>
              <span style={{ fontSize: "0.8125rem", color: "#8888a0", display: "flex", alignItems: "center", gap: "0.375rem" }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                </svg>
                Saved
              </span>
            </Link>
          </div>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
