import { Bricolage_Grotesque, Inter } from "next/font/google";
import "./christmas.css";

// The Christmas list keeps the original artifact's own type (Bricolage
// Grotesque display, Inter body), self-hosted through next/font and used only
// under .xmas — nothing else on the hub changes.
const display = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["500", "700"],
  variable: "--font-xmas-display",
  display: "swap",
});
const body = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-xmas-body",
  display: "swap",
});

export default function ChristmasLayout({ children }: { children: React.ReactNode }) {
  return <div className={`xmas ${display.variable} ${body.variable}`}>{children}</div>;
}
