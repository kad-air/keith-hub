import type { Metadata } from "next";
import { FretboardCompanionClient } from "./FretboardCompanionClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Fretboard — Practice — hub" };

export default function FretboardCompanionPage() {
  return <FretboardCompanionClient />;
}
