import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { deriveAuthToken, publicUrl } from "@/lib/auth";

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const password = form.get("password") as string | null;
  const expected = process.env.FEED_PASSWORD;

  if (!expected || password !== expected) {
    return NextResponse.redirect(publicUrl("/login?error=1", request));
  }

  const token = await deriveAuthToken(expected);
  const response = NextResponse.redirect(publicUrl("/", request));
  response.cookies.set("hub-auth", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  return response;
}
