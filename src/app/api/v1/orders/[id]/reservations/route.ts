import { createSupabaseServerClient } from "@/lib/supabase/server";
import { entityIdSchema } from "@/lib/validation/catalog";
import { reserveSchema } from "@/lib/validation/reservations";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { parseJsonBody } from "@/server/request";
import { getOrderReservations, reserveForOrder } from "@/server/reservations";

// Rezerwacje zlecenia (Etap 11, ADR 014): GET — pozycje z rezerwacją i historia zdarzeń; POST — „Zarezerwuj”
// (bez items = automatycznie min(pozostało do zarezerwowania, wolne) dla każdej pozycji). BIURO, ADMIN.
export async function GET(_request: Request, ctx: RouteContext<"/api/v1/orders/[id]/reservations">) {
  const auth = await requireApiRole("ADMIN", "BIURO");
  if (!auth.ok) return auth.response;

  const id = entityIdSchema.safeParse((await ctx.params).id);
  if (!id.success) return jsonError(400, "VALIDATION", "Nieprawidłowy identyfikator zlecenia");

  const result = await getOrderReservations(await createSupabaseServerClient(), id.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data);
}

export async function POST(request: Request, ctx: RouteContext<"/api/v1/orders/[id]/reservations">) {
  const auth = await requireApiRole("ADMIN", "BIURO");
  if (!auth.ok) return auth.response;

  const id = entityIdSchema.safeParse((await ctx.params).id);
  if (!id.success) return jsonError(400, "VALIDATION", "Nieprawidłowy identyfikator zlecenia");

  const body = await parseJsonBody(request, reserveSchema);
  if (!body.ok) return body.response;

  const result = await reserveForOrder(await createSupabaseServerClient(), id.data, body.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message, undefined, result.error.details);
  return jsonOk(result.data, result.data.idempotentReplay ? 200 : 201);
}
