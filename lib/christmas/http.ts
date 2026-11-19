import { NextResponse } from "next/server";
import { ChristmasInputError } from "@/lib/christmas/store";

// One wrapper for every Christmas write route: parse the JSON body, run the
// store call, answer { rev } — or 400 with the reason, 404 for a missing row.
export async function respond(
  request: Request | null,
  fn: (body: unknown) => number | null,
): Promise<NextResponse> {
  let body: unknown = null;
  if (request) {
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: { code: "bad_request", message: "Expected JSON." } }, { status: 400 });
    }
  }
  try {
    const rev = fn(body);
    if (rev == null) return NextResponse.json({ error: { code: "not_found" } }, { status: 404 });
    return NextResponse.json({ rev });
  } catch (err) {
    if (err instanceof ChristmasInputError) {
      return NextResponse.json({ error: { code: "bad_request", message: err.message } }, { status: 400 });
    }
    console.error("[api/christmas] write failed:", err);
    return NextResponse.json({ error: { code: "server_error" } }, { status: 500 });
  }
}
