import { createSupabaseServerClient } from "@/lib/supabase/server";
import { reversalSchema } from "@/lib/validation/stock";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { parseJsonBody } from "@/server/request";
import { createReversal } from "@/server/stock";

// Cofnięcie operacji (storno, wyłącznie ADMIN): ruchy odwrotne do wszystkich ruchów oryginału, z powodem.
// Funkcja DB stock_reverse (blokady, idempotencja). 201 — nowe storno, 200 — powtórzenie; 409 ALREADY_REVERSED /
// NOT_REVERSIBLE / INSUFFICIENT_STOCK (z `details.available` i `details.locationCode`).
export async function POST(request: Request) {
  const auth = await requireApiRole("ADMIN");
  if (!auth.ok) return auth.response;

  const body = await parseJsonBody(request, reversalSchema);
  if (!body.ok) return body.response;

  const result = await createReversal(await createSupabaseServerClient(), body.data);
  if (!result.ok) {
    return jsonError(result.error.status, result.error.code, result.error.message, undefined, result.error.details);
  }
  return jsonOk(result.data, result.data.idempotentReplay ? 200 : 201);
}
