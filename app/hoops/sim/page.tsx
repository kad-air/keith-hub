import { redirect } from "next/navigation";

// Dynamic so the redirect is a real 307 with a Location header; a
// prerendered redirect() ships as a cached HTML page instead.
export const dynamic = "force-dynamic";

/** The Sim area's landing is its first tab, the nightly projection. */
export default function HoopsSimLandingPage() {
  redirect("/hoops/sim/projections");
}
