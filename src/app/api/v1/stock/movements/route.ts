import { createSupabaseServerClient } from "@/lib/supabase/server";
import { historyQuerySchema } from "@/lib/validation/stock";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { parseQuery } from "@/server/request";
import { listMovements } from "@/server/stock";

// Historia ruchów: ?type=&q=&materialId=&locationId=&userId=&orderId=&operationId=&from=&to=&page=&pageSize=.
// Filtrowanie i paginacja w SQL (list_stock_movements). ADMIN, BIURO — wszystkie; PRODUKCJA — wyłącznie własne
// (wymusza funkcja DB). Przesunięcie (i jego storno) jako jeden wiersz „skąd → dokąd”.
export async function GET(request: Request) {
  const auth = await requireApiRole();
  if (!auth.ok) return auth.response;

  const query = parseQuery(request.url, historyQuerySchema);
  if (!query.ok) return query.response;

  const result = await listMovements(await createSupabaseServerClient(), query.data, { collapseTransfers: true });
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data);
}
