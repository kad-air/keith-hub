import { getDb } from "@/lib/db";
import { TRACKER_CONFIGS } from "@/lib/tracker-config";
import { fetchCollectionItems, normalizeItems } from "@/lib/craft";
import { sendPush } from "@/lib/push";

// Morning delivery in the user's timezone — don't fire at UTC midnight.
const NOTIFY_TIMEZONE = "America/Denver";
const NOTIFY_HOUR = 8;

function getLocalDate(): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: NOTIFY_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function getLocalHour(): number {
  const h = new Intl.DateTimeFormat("en-US", {
    timeZone: NOTIFY_TIMEZONE,
    hour: "numeric",
    hour12: false,
  }).format(new Date());
  return parseInt(h, 10);
}

function getLastCheckedDate(): string | null {
  try {
    const db = getDb();
    const row = db
      .prepare("SELECT value FROM kv WHERE key = 'release_notify_last'")
      .get() as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function setLastCheckedDate(date: string): void {
  const db = getDb();
  db.prepare(
    "INSERT OR REPLACE INTO kv (key, value) VALUES ('release_notify_last', ?)",
  ).run(date);
}

/**
 * Checks all tracker collections for items releasing today and sends
 * one push notification per releasing item. Runs at most once per
 * calendar day in NOTIFY_TIMEZONE, and only after NOTIFY_HOUR local.
 */
export async function checkReleaseNotifications(): Promise<void> {
  const today = getLocalDate();

  // Only run once per local day
  if (getLastCheckedDate() === today) return;
  // Hold off until the local morning threshold
  if (getLocalHour() < NOTIFY_HOUR) return;
  setLastCheckedDate(today);

  console.log(`[release-notify] Checking release dates for ${today}`);

  const releasing: Array<{
    name: string;
    tracker: string;
    slug: string;
    subtitle: string;
  }> = [];

  for (const config of TRACKER_CONFIGS) {
    try {
      const data = await fetchCollectionItems(config.collectionId);
      const items = normalizeItems(data.items, config);

      for (const item of items) {
        if (!item.releaseDate) continue;
        // Craft dates come as ISO strings — compare just the YYYY-MM-DD part
        const itemDate = item.releaseDate.slice(0, 10);
        if (itemDate === today) {
          releasing.push({
            name: item.name,
            tracker: config.label,
            slug: config.slug,
            subtitle: item.subtitle,
          });
        }
      }
    } catch (err) {
      console.error(`[release-notify] Failed to check ${config.label}:`, err);
    }
  }

  if (releasing.length === 0) {
    console.log("[release-notify] No releases today");
    return;
  }

  for (const r of releasing) {
    const body = r.subtitle ? `${r.subtitle} — ${r.name}` : r.name;
    await sendPush({
      title: `${r.tracker} out today`,
      body,
      url: `/trackers/${r.slug}`,
    });
  }

  console.log(
    `[release-notify] Sent ${releasing.length} notification(s): ${releasing.map((r) => r.name).join(", ")}`,
  );
}
