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
    "/((?!_next/static|_next/image|icons|manifest\\.webmanifest|sw\\.js|swe-worker-.*\\.js|login|api/auth).*)",
  ],
};
