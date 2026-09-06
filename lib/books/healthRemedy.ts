// What a health finding actually asks the reader to DO.
//
// 🔴 Imports NOTHING at runtime — the type import is erased — because this is
// read by components/BookDetailClient.tsx, a client component. health.ts pulls
// in AdmZip, so importing a VALUE from it would ship a zip library to the
// browser: the pages.ts lesson (182 kB of AdmZip reached /books/stats with
// everything still working perfectly, and only the bundle size ever said so).
import type { HealthCode, HealthFinding } from "./health.ts";

/**
 * Findings a METADATA edit fixes, leaving the file alone.
 *
 * 🔴 The card's standing remedy is "replace the file, which is a new book with
 * a fresh sync identity" (BOOKS_PLAN §4 byte identity) — true of every finding
 * that is about the BYTES. A wrong dc:language is not: the prose is fine, the
 * tag is wrong, and Edit details fixes it for free without touching the file
 * or your place in the book. Telling someone to re-download a perfectly good
 * book to correct a two-letter tag would be the worst advice on the page.
 */
export const METADATA_FIXABLE: readonly HealthCode[] = ["language-mismatch"];

/** Does this finding need different bytes to resolve? */
export function needsReplacementFile(finding: HealthFinding): boolean {
  return finding.severity !== "info" && !METADATA_FIXABLE.includes(finding.code);
}
