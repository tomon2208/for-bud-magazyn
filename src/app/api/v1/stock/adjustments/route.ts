import { createSupabaseServerClient } from "@/lib/supabase/server";
import { adjustmentSchema } from "@/lib/validation/stock";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { parseJsonBody } from "@/server/request";
import { createAdjustment } from "@/server/stock";

// Korekta stanu (wyłącznie ADMIN): „ustaw stan na X” z powodem. Stan zmienia funkcja DB stock_adjust (blokady,
// idempotencja). 201 — nowa korekta, 200 — powtórzenie; 409 STOCK_CHANGED (z `details.current`) — stan zmienił się
// od chwili, gdy ADMIN go widział; 409 NO_CHANGE — różnica 0, nic nie zapisano.
export async function POST(request: Request) {
  const auth = await requireApiRole("ADMIN");
  if (!auth.ok) return auth.response;

  const body = await parseJsonBody(request, adjustmentSchema);
  if (!body.ok) return body.response;

  const result = await createAdjustment(await createSupabaseServerClient(), body.data);
  if (!result.ok) {
    return jsonError(result.error.status, result.error.code, result.error.message, undefined, result.error.details);
  }
  return jsonOk(result.data, result.data.idempotentReplay ? 200 : 201);
}
