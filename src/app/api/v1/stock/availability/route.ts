import { createSupabaseServerClient } from "@/lib/supabase/server";
import { availabilityQuerySchema } from "@/lib/validation/reservations";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { parseQuery } from "@/server/request";
import { getMaterialAvailability } from "@/server/reservations";

// Dostępność materiału z rezerwacjami (terminal WYDANIE, szczegóły materiału): stan, zarezerwowane, wolne,
// rezerwacja wskazanego zlecenia, lista zleceń z rezerwacją. Każda aktywna rola.
export async function GET(request: Request) {
  const auth = await requireApiRole();
  if (!auth.ok) return auth.response;

  const q = parseQuery(request.url, availabilityQuerySchema);
  if (!q.ok) return q.response;

  const result = await getMaterialAvailability(await createSupabaseServerClient(), q.data.materialId, q.data.orderId);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data);
}
