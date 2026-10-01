import { createSupabaseServerClient } from "@/lib/supabase/server";
import { entityIdSchema } from "@/lib/validation/catalog";
import { updateOrderSchema } from "@/lib/validation/orders";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { updateOrder } from "@/server/orders";
import { parseJsonBody } from "@/server/request";

// Edycja nazwy/notatki i zmiana statusu zlecenia (BIURO, ADMIN). Ponowne otwarcie (→ OPEN) dozwolone.
export async function PATCH(request: Request, ctx: RouteContext<"/api/v1/orders/[id]">) {
  const auth = await requireApiRole("ADMIN", "BIURO");
  if (!auth.ok) return auth.response;

  const id = entityIdSchema.safeParse((await ctx.params).id);
  if (!id.success) return jsonError(400, "VALIDATION", "Nieprawidłowy identyfikator zlecenia");

  const body = await parseJsonBody(request, updateOrderSchema);
  if (!body.ok) return body.response;

  const result = await updateOrder(await createSupabaseServerClient(), id.data, body.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data);
}
