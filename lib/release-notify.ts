import { getDb } from "@/lib/db";
import { TRACKER_CONFIGS } from "@/lib/tracker-config";
import { fetchCollectionItems, normalizeItems } from "@/lib/craft";
import { sendPush } from "@/lib/push";

function todayStr(): string {
  // Local date string YYYY-MM-DD
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
 * a push notification for each. Runs at most once per calendar day.
 */
export async function checkReleaseNotifications(): Promise<void> {
  const today = todayStr();

  // Only run once per day
  if (getLastCheckedDate() === today) return;
  setLastCheckedDate(today);

  console.log(`[release-notify] Checking release dates for ${today}`);

  const releasing: Array<{ name: string; tracker: string; subtitle: string }> = [];

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

  // Build notification — batch into one if multiple
  if (releasing.length === 1) {
    const r = releasing[0];
    const body = r.subtitle
      ? `${r.subtitle} — ${r.name}`
      : r.name;
    await sendPush({
      title: `${r.tracker} out today`,
      body,
      url: `/trackers/${TRACKER_CONFIGS.find((c) => c.label === r.tracker)?.slug ?? ""}`,
    });
  } else {
    const lines = releasing.map((r) => {
      return r.subtitle ? `${r.subtitle} — ${r.name}` : r.name;
    });
    await sendPush({
      title: `${releasing.length} releases today`,
      body: lines.join("\n"),
      url: "/",
    });
  }

  console.log(
    `[release-notify] Sent notification for ${releasing.length} release(s): ${releasing.map((r) => r.name).join(", ")}`,
  );
}
