import { createSupabaseServerClient } from "@/lib/supabase/server";
import { issueSchema } from "@/lib/validation/stock";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { parseJsonBody } from "@/server/request";
import { createIssue } from "@/server/stock";

// Wydanie towaru (PRODUKCJA, ADMIN): na zlecenie ALBO z powodem. Stan zmienia wyłącznie funkcja DB stock_issue
// (transakcja, blokady, idempotencja). 201 — nowa operacja, 200 — powtórzenie; 409 INSUFFICIENT_STOCK
// z `details.available` (dostępna ilość w lokalizacji).
export async function POST(request: Request) {
  const auth = await requireApiRole("PRODUKCJA", "ADMIN");
  if (!auth.ok) return auth.response;

  const body = await parseJsonBody(request, issueSchema);
  if (!body.ok) return body.response;

  const result = await createIssue(await createSupabaseServerClient(), body.data);
  if (!result.ok) {
    return jsonError(result.error.status, result.error.code, result.error.message, undefined, result.error.details);
  }
  return jsonOk(result.data, result.data.idempotentReplay ? 200 : 201);
}
