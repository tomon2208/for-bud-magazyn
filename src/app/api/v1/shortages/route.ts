import { createSupabaseServerClient } from "@/lib/supabase/server";
import { shortagesQuerySchema } from "@/lib/validation/requirements";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { parseQuery } from "@/server/request";
import { listShortages } from "@/server/requirements";

// Braki zbiorczo per materiał po zleceniach Otwarte + W produkcji (BIURO, ADMIN). Filtry: supplier, category, onlyShort.
export async function GET(request: Request) {
  const auth = await requireApiRole("ADMIN", "BIURO");
  if (!auth.ok) return auth.response;

  const query = parseQuery(request.url, shortagesQuerySchema);
  if (!query.ok) return query.response;

  const result = await listShortages(await createSupabaseServerClient(), query.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data);
}
