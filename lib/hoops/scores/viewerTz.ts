// The viewer's time zone on the server: the IANA zone the device reported in
// the TZ_COOKIE (components/hoops/scores/ViewerTz.tsx writes it), or Mountain
// until it has. Every scores page, and the live and game-log endpoints, read
// it here so the server's "today", its spoiler cutoffs and its tip times are
// the viewer's — never the container's UTC.

import { cookies } from "next/headers";
import { SCORES_TZ, TZ_COOKIE, normalizeTz } from "./dates.ts";

export function viewerTz(): string {
  try {
    return normalizeTz(cookies().get(TZ_COOKIE)?.value) ?? SCORES_TZ;
  } catch {
    // Outside a request (a build-time render): the fallback.
    return SCORES_TZ;
  }
}
