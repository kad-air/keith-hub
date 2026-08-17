import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { AUTH_COOKIE, deriveAuthToken, publicUrl } from "@/lib/auth";
import { TRACKERS_ENABLED } from "@/lib/tracker-config";

// The Craft-backed Tracking section is hidden (Stow replaced it) — see
// lib/tracker-config.ts for the one flag that governs it. Refusing here rather
// than only inside the routes is deliberate, for two reasons:
//   1. The pages' own `notFound()` renders the not-found BODY but returns HTTP
//      200 — an async `generateMetadata` commits the response status before the
//      component throws (Next 14). Middleware answers with a real 404.
//   2. Nothing tracker-shaped executes at all, so a stale bookmark or an old
//      release-alert deep link can't spend a Craft API call on a dead section.
function isHiddenTrackerPath(pathname: string): boolean {
  return (
    pathname === "/trackers" ||
    pathname.startsWith("/trackers/") ||
    pathname === "/api/trackers" ||
    pathname.startsWith("/api/trackers/")
  );
}

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
  // Routing rule, not an auth rule — so it runs before the cookie check and a
  // logged-out request gets the same 404 instead of a login redirect to a
  // section that no longer exists.
  if (!TRACKERS_ENABLED && isHiddenTrackerPath(request.nextUrl.pathname)) {
    if (request.nextUrl.pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    // Rewrite to a path no route matches: the App Router answers it with a
    // real 404 status AND its own not-found page. `NextResponse.rewrite(…,
    // {status: 404})` does NOT work — the status of a rewrite comes from the
    // rewritten route, so it renders the not-found body under a 200 (measured).
    return NextResponse.rewrite(new URL("/section-not-found", request.url));
  }

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
