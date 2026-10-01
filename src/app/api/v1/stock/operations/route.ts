import { createSupabaseServerClient } from "@/lib/supabase/server";
import { listMovementsQuerySchema } from "@/lib/validation/stock";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { parseQuery } from "@/server/request";
import { listMovements } from "@/server/stock";

// Lista operacji (linie ruchów z danymi nagłówka): ?type=RECEIPT&q=&from=&to=&page=.
// ADMIN, BIURO — wszystkie; PRODUKCJA — wyłącznie własne (wymusza funkcja DB list_stock_movements).
export async function GET(request: Request) {
  const auth = await requireApiRole();
  if (!auth.ok) return auth.response;

  const query = parseQuery(request.url, listMovementsQuerySchema);
  if (!query.ok) return query.response;

  const result = await listMovements(await createSupabaseServerClient(), query.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data);
}
