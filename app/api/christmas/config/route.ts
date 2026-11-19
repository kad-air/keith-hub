import { clearTotalBudget, setTotalBudget } from "@/lib/christmas/store";
import { respond } from "@/lib/christmas/http";

export const dynamic = "force-dynamic";

/** `{ totalBudget: number | null }` */
export function PUT(request: Request) {
  return respond(request, (body) => setTotalBudget(body));
}

/** Clears the total (Undo of the first time it was set). */
export function DELETE() {
  return respond(null, () => clearTotalBudget());
}
