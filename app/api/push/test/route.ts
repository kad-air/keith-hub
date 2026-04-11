import { NextResponse } from "next/server";
import { sendPush } from "@/lib/push";

export const dynamic = "force-dynamic";

// Send a test push notification
export async function POST() {
  const sent = await sendPush({
    title: "hub",
    body: "Notifications are working.",
    url: "/",
  });
  return NextResponse.json({ sent });
}
