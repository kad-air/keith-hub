import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { AUTH_COOKIE, deriveAuthToken, publicUrl } from "@/lib/auth";

// Charts + setlists are viewable (not editable) without auth — see
// app/charts/*/page.tsx, which reads the same cookie to decide whether to
// render write affordances. Only GET requests to these exact page routes are
// public; every /api/* route (including the charts/setlists write endpoints)
// stays fully gated.
function isPublicReadPath(pathname: string): boolean {
  return (
    pathname === "/charts" ||
    pathname === "/charts/setlists" ||
    /^\/charts\/setlists\/[^/]+$/.test(pathname) ||
    /^\/charts\/[^/]+$/.test(pathname)
  );
}

export async function middleware(request: NextRequest) {
  const password = process.env.FEED_PASSWORD;
  if (!password) {
    // No password configured — allow everything (local dev without auth)
    return NextResponse.next();
  }

  const cookie = request.cookies.get(AUTH_COOKIE);
  const expected = await deriveAuthToken(password);
  if (cookie?.value === expected) {
    return NextResponse.next();
  }

  if (request.method === "GET" && isPublicReadPath(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  // API routes get 401 instead of redirect
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.redirect(publicUrl("/login", request));
}

export const config = {
  matcher: [
    // offline.html is the service worker's offline fallback page — the SW
    // precaches it at install time, including for logged-out visitors on the
    // public charts pages. If the middleware gated it, that precache fetch
    // would follow the 302 and cache the LOGIN page as the fallback.
    //
    // api/hoops/import (kad-air/keith-hub#73) is exempted the same way
    // api/auth is: it does its OWN auth entirely (a dedicated
    // HOOPS_IMPORT_TOKEN bearer check, not the FEED_PASSWORD cookie) —
    // see app/api/hoops/import/route.ts. 🔴 That route's own check fails
    // CLOSED when its token is unset, the opposite of this middleware's
    // FEED_PASSWORD convention below — do not "fix" that to match this file.
    "/((?!_next/static|_next/image|icons|manifest\\.webmanifest|sw\\.js|swe-worker-.*\\.js|offline\\.html|login|api/auth|api/hoops/import).*)",
  ],
};
