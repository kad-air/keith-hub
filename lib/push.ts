import webpush from "web-push";
import { getDb } from "@/lib/db";

// Configure web-push with VAPID keys
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:noreply@example.com",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
}

export function getSubscription(): webpush.PushSubscription | null {
  try {
    const db = getDb();
    const row = db
      .prepare("SELECT value FROM kv WHERE key = 'push_subscription'")
      .get() as { value: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.value) as webpush.PushSubscription;
  } catch {
    return null;
  }
}

export function saveSubscription(sub: webpush.PushSubscription): void {
  const db = getDb();
  db.prepare(
    "INSERT OR REPLACE INTO kv (key, value) VALUES ('push_subscription', ?)",
  ).run(JSON.stringify(sub));
}

export function removeSubscription(): void {
  try {
    const db = getDb();
    db.prepare("DELETE FROM kv WHERE key = 'push_subscription'").run();
  } catch {
    // already gone
  }
}

export async function sendPush(payload: {
  title: string;
  body: string;
  url?: string;
  icon?: string;
}): Promise<boolean> {
  const sub = getSubscription();
  if (!sub) return false;

  try {
    await webpush.sendNotification(sub, JSON.stringify(payload));
    return true;
  } catch (err: unknown) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    // 410 Gone or 404 — subscription expired, remove it
    if (statusCode === 410 || statusCode === 404) {
      removeSubscription();
    }
    console.error("[push] Send failed:", err);
    return false;
  }
}
