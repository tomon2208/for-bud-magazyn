import { createSupabaseServerClient } from "@/lib/supabase/server";
import { entityIdSchema } from "@/lib/validation/catalog";
import { closeSessionSchema } from "@/lib/validation/inventory";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { closeInventorySession } from "@/server/inventory";
import { parseJsonBody } from "@/server/request";

// Zamknięcie sesji (BIURO, ADMIN). Niepoliczone lokalizacje i niezatwierdzone pozycje nie są zerowane.
export async function POST(request: Request, ctx: RouteContext<"/api/v1/inventory/sessions/[id]/close">) {
  const auth = await requireApiRole("ADMIN", "BIURO");
  if (!auth.ok) return auth.response;

  const id = entityIdSchema.safeParse((await ctx.params).id);
  if (!id.success) return jsonError(400, "VALIDATION", "Nieprawidłowy identyfikator sesji");

  const body = await parseJsonBody(request, closeSessionSchema);
  if (!body.ok) return body.response;

  const result = await closeInventorySession(await createSupabaseServerClient(), id.data, body.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data);
}
