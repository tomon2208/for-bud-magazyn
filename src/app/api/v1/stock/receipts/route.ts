import { createSupabaseServerClient } from "@/lib/supabase/server";
import { receiptSchema } from "@/lib/validation/stock";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { parseJsonBody } from "@/server/request";
import { createReceipt } from "@/server/stock";

// Przyjęcie towaru (PRODUKCJA, ADMIN). Stan zmienia wyłącznie funkcja DB stock_receipt (transakcja, blokady,
// idempotencja po client_request_id). 201 — nowa operacja, 200 — powtórzenie tego samego żądania.
export async function POST(request: Request) {
  const auth = await requireApiRole("PRODUKCJA", "ADMIN");
  if (!auth.ok) return auth.response;

  const body = await parseJsonBody(request, receiptSchema);
  if (!body.ok) return body.response;

  const result = await createReceipt(await createSupabaseServerClient(), body.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data, result.data.idempotentReplay ? 200 : 201);
}
