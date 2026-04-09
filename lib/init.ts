import { getDb } from "@/lib/db";
import { startPolling } from "@/lib/fetcher";

let initialized = false;

export function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;

  try {
    const db = getDb();
    startPolling(db);
  } catch (err) {
    console.error("[init] Failed to initialize:", err);
    // Reset flag so next request can retry
    initialized = false;
  }
}
