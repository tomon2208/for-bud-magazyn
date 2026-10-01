import { createSupabaseServerClient } from "@/lib/supabase/server";
import { transferSchema } from "@/lib/validation/stock";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { parseJsonBody } from "@/server/request";
import { createTransfer } from "@/server/stock";

// Przesunięcie A → B (PRODUKCJA, ADMIN): jedna operacja TRANSFER + dwa ruchy w jednej transakcji (stock_transfer).
// 201 — nowa operacja, 200 — powtórzenie; 409 INSUFFICIENT_STOCK z `details.available`.
export async function POST(request: Request) {
  const auth = await requireApiRole("PRODUKCJA", "ADMIN");
  if (!auth.ok) return auth.response;

  const body = await parseJsonBody(request, transferSchema);
  if (!body.ok) return body.response;

  const result = await createTransfer(await createSupabaseServerClient(), body.data);
  if (!result.ok) {
    return jsonError(result.error.status, result.error.code, result.error.message, undefined, result.error.details);
  }
  return jsonOk(result.data, result.data.idempotentReplay ? 200 : 201);
}
