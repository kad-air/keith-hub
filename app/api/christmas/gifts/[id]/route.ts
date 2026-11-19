import { deleteGift, setGift, updateGift } from "@/lib/christmas/store";
import { respond } from "@/lib/christmas/http";

export const dynamic = "force-dynamic";
type Ctx = { params: { id: string } };

/** Create or replace a gift (also how Undo restores a deleted or edited one). */
export function PUT(request: Request, { params }: Ctx) {
  return respond(request, (body) => setGift(params.id, body));
}

/** Change some fields. */
export function PATCH(request: Request, { params }: Ctx) {
  return respond(request, (body) => updateGift(params.id, body));
}

export function DELETE(_request: Request, { params }: Ctx) {
  return respond(null, () => deleteGift(params.id));
}
