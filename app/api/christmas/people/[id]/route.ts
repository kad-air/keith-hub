import { deletePerson, setPerson, updatePerson } from "@/lib/christmas/store";
import { respond } from "@/lib/christmas/http";

export const dynamic = "force-dynamic";
type Ctx = { params: { id: string } };

/** Create or replace a budget line. */
export function PUT(request: Request, { params }: Ctx) {
  return respond(request, (body) => setPerson(params.id, body));
}

export function PATCH(request: Request, { params }: Ctx) {
  return respond(request, (body) => updatePerson(params.id, body));
}

/** Removes the budget line only; that person's gifts stay. */
export function DELETE(_request: Request, { params }: Ctx) {
  return respond(null, () => deletePerson(params.id));
}
