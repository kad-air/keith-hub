import { NextRequest, NextResponse } from "next/server";
import {
  deleteSetlist,
  getSetlist,
  getSetlistMeta,
  renameSetlist,
  setSetlistOffline,
} from "@/lib/setlists";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  try {
    const result = getSetlist(params.id);
    if (!result) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (err) {
    console.error("[api/setlists/[id] GET] Error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

// Rename and/or toggle offline. Both fields optional; at least one must be
// present. Returns the updated setlist meta.
export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  try {
    if (!getSetlistMeta(params.id)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const body = await request.json();
    const hasName = typeof body.name === "string";
    const hasOffline = typeof body.offline === "boolean";
    if (!hasName && !hasOffline) {
      return NextResponse.json(
        { error: "name or offline is required" },
        { status: 400 },
      );
    }
    if (hasName) {
      if (!body.name.trim()) {
        return NextResponse.json(
          { error: "name cannot be empty" },
          { status: 400 },
        );
      }
      renameSetlist(params.id, body.name);
    }
    if (hasOffline) {
      setSetlistOffline(params.id, body.offline);
    }
    return NextResponse.json({ setlist: getSetlistMeta(params.id) });
  } catch (err) {
    console.error("[api/setlists/[id] PUT] Error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  try {
    deleteSetlist(params.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api/setlists/[id] DELETE] Error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
