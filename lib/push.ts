import fs from "fs";
import path from "path";
import webpush from "web-push";

const DATA_DIR = path.join(process.cwd(), "data");
const SUB_PATH = path.join(DATA_DIR, "push-subscription.json");

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
    if (!fs.existsSync(SUB_PATH)) return null;
    const raw = fs.readFileSync(SUB_PATH, "utf-8");
    return JSON.parse(raw) as webpush.PushSubscription;
  } catch {
    return null;
  }
}

export function saveSubscription(sub: webpush.PushSubscription): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SUB_PATH, JSON.stringify(sub, null, 2));
}

export function removeSubscription(): void {
  try {
    fs.unlinkSync(SUB_PATH);
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
