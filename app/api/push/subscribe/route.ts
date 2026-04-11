import { NextResponse } from "next/server";
import { saveSubscription, removeSubscription, getSubscription } from "@/lib/push";

export const dynamic = "force-dynamic";

// Save push subscription
export async function POST(req: Request) {
  try {
    const sub = await req.json();
    if (!sub?.endpoint) {
      return NextResponse.json({ error: "Invalid subscription" }, { status: 400 });
    }
    saveSubscription(sub);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}

// Remove push subscription
export async function DELETE() {
  removeSubscription();
  return NextResponse.json({ ok: true });
}

// Check if a subscription exists
export async function GET() {
  const sub = getSubscription();
  return NextResponse.json({ subscribed: !!sub });
}
