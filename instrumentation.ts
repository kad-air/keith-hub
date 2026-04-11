export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getDb } = await import("@/lib/db");
    const { startPolling } = await import("@/lib/fetcher");
    startPolling(getDb());
    console.log("[instrumentation] Poller started");
  }
}
