import TuneClient from "@/components/TuneClient";

export const dynamic = "force-dynamic";

// Tune — the control room for the feed: sources roster (health, frequency,
// add/pause), the All-view algorithm knobs with a live preview, and the raw
// config YAML. All three panes edit the same live config document (DB copy,
// seeded from config/feeds.yml — see lib/config.ts).
export default function TunePage() {
  return <TuneClient />;
}
