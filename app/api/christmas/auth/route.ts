import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { publicUrl } from "@/lib/auth";
import { XMAS_COOKIE, XMAS_COOKIE_MAX_AGE, deriveChristmasToken, safeEqual } from "@/lib/christmas/auth";
import { allow, clientAddress } from "@/lib/christmas/rateLimit";

// The passcode form's POST. 303, not 307, for the same iOS Safari reason as
// /api/auth/login (a 307 re-POSTs to the page). Attempts are limited per
// address — the passcode is short and shared, and this is on the internet.
export async function POST(request: NextRequest) {
  const passcode = process.env.CHRISTMAS_PASSCODE;
  if (!passcode) return NextResponse.redirect(publicUrl("/christmas/login?error=off", request), 303);

  const limit = allow(`login:${clientAddress(request.headers)}`, [[8, 15 * 60_000], [30, 24 * 3600_000]]);
  if (!limit.ok) return NextResponse.redirect(publicUrl("/christmas/login?error=wait", request), 303);

  const form = await request.formData();
  const given = String(form.get("passcode") ?? "").trim();
  if (!given || !(await safeEqual(given, passcode))) {
    return NextResponse.redirect(publicUrl("/christmas/login?error=1", request), 303);
  }

  const response = NextResponse.redirect(publicUrl("/christmas", request), 303);
  response.cookies.set(XMAS_COOKIE, await deriveChristmasToken(passcode), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: XMAS_COOKIE_MAX_AGE,
  });
  return response;
}
