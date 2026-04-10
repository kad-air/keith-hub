import type { Item } from "./types";

export type DateBucket = "Today" | "Yesterday" | "This week" | "Earlier";

export interface GroupedItems {
  bucket: DateBucket;
  items: Item[];
}

const BUCKET_ORDER: DateBucket[] = [
  "Today",
  "Yesterday",
  "This week",
  "Earlier",
];

export function bucketFor(publishedAt: string, now: Date): DateBucket {
  const then = new Date(publishedAt);
  const diffMs = now.getTime() - then.getTime();
  const diffDays = Math.floor(diffMs / 86_400_000);

  // Compare calendar days, not 24-hour windows.
  const sameDay =
    then.getFullYear() === now.getFullYear() &&
    then.getMonth() === now.getMonth() &&
    then.getDate() === now.getDate();
  if (sameDay) return "Today";

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday =
    then.getFullYear() === yesterday.getFullYear() &&
    then.getMonth() === yesterday.getMonth() &&
    then.getDate() === yesterday.getDate();
  if (isYesterday) return "Yesterday";

  if (diffDays < 7) return "This week";
  return "Earlier";
}

/**
 * Buckets items into Today / Yesterday / This week / Earlier while
 * preserving the input order *within* each bucket. The input order is
 * authoritative — callers control sorting (rank or recency) before
 * calling this. Empty buckets are dropped from the output.
 */
export function groupByDate(items: Item[]): GroupedItems[] {
  if (items.length === 0) return [];
  const now = new Date();
  const map = new Map<DateBucket, Item[]>();

  for (const item of items) {
    const bucket = bucketFor(item.published_at, now);
    const arr = map.get(bucket);
    if (arr) arr.push(item);
    else map.set(bucket, [item]);
  }

  const result: GroupedItems[] = [];
  for (const bucket of BUCKET_ORDER) {
    const arr = map.get(bucket);
    if (arr && arr.length > 0) result.push({ bucket, items: arr });
  }
  return result;
}
