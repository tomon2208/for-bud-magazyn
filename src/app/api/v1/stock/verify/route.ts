import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { verifyStock } from "@/server/stock";

// Spójność stanów (ADMIN): stany bieżące vs suma ruchów (verify_stock). Pusta lista rozbieżności = OK.
export async function GET() {
  const auth = await requireApiRole("ADMIN");
  if (!auth.ok) return auth.response;

  const result = await verifyStock(await createSupabaseServerClient());
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data);
}
