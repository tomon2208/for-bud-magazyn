import { createSupabaseServerClient } from "@/lib/supabase/server";
import { listStockQuerySchema } from "@/lib/validation/stock";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { parseQuery } from "@/server/request";
import { listStock } from "@/server/stock";

// Stany magazynowe (wszyscy aktywni). Wiersze z zerem pomijane.
export async function GET(request: Request) {
  const auth = await requireApiRole();
  if (!auth.ok) return auth.response;

  const query = parseQuery(request.url, listStockQuerySchema);
  if (!query.ok) return query.response;

  const result = await listStock(await createSupabaseServerClient(), query.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data);
}
