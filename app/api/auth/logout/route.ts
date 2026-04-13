import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { publicUrl } from "@/lib/auth";

export async function POST(request: NextRequest) {
  const response = NextResponse.redirect(publicUrl("/login", request), 303);
  response.cookies.set("hub-auth", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
