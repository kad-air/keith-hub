import { NextRequest, NextResponse } from "next/server";
import { duplicateSetlist, getSetlistMeta } from "@/lib/setlists";

export const dynamic = "force-dynamic";

// Copy a setlist into a new one with the same charts in the same order.
// Body `{ name? }`; defaults to "<name> (copy)". Returns the new setlist meta.
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  try {
    const source = getSetlistMeta(params.id);
    if (!source) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const body = await request.json().catch(() => ({}));
    const name =
      typeof body?.name === "string" && body.name.trim()
        ? body.name
        : `${source.name} (copy)`;
    const setlist = duplicateSetlist(params.id, name);
    return NextResponse.json({ setlist }, { status: 201 });
  } catch (err) {
    console.error("[api/setlists/[id]/duplicate POST] Error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
