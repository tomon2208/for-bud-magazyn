import { createSupabaseServerClient } from "@/lib/supabase/server";
import { entityIdSchema } from "@/lib/validation/catalog";
import { releaseSchema } from "@/lib/validation/reservations";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { parseJsonBody } from "@/server/request";
import { releaseReservation } from "@/server/reservations";

// Ręczne zwolnienie rezerwacji (całość zlecenia / materiał / część) z opcjonalnym powodem. BIURO, ADMIN.
export async function POST(request: Request, ctx: RouteContext<"/api/v1/orders/[id]/reservations/release">) {
  const auth = await requireApiRole("ADMIN", "BIURO");
  if (!auth.ok) return auth.response;

  const id = entityIdSchema.safeParse((await ctx.params).id);
  if (!id.success) return jsonError(400, "VALIDATION", "Nieprawidłowy identyfikator zlecenia");

  const body = await parseJsonBody(request, releaseSchema);
  if (!body.ok) return body.response;

  const result = await releaseReservation(await createSupabaseServerClient(), id.data, body.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message, undefined, result.error.details);
  return jsonOk(result.data, result.data.idempotentReplay ? 200 : 201);
}
