import { NextRequest, NextResponse } from "next/server";
import { createSetlist, listSetlists } from "@/lib/setlists";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json({ setlists: listSetlists() });
  } catch (err) {
    console.error("[api/setlists GET] Error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const setlist = createSetlist(name);
    return NextResponse.json({ setlist }, { status: 201 });
  } catch (err) {
    console.error("[api/setlists POST] Error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
