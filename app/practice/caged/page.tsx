import type { Metadata } from "next";
import { CagedClient } from "./CagedClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "CAGED — Practice — hub" };

export default function CagedPage() {
  return <CagedClient />;
}
