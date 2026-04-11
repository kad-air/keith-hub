import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { deriveAuthToken, publicUrl } from "@/lib/auth";

const AUTH_COOKIE = "hub-auth";

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
