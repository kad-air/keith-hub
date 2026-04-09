import type { Metadata } from "next";
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
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
