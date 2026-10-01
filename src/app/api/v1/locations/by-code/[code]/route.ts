import { createSupabaseServerClient } from "@/lib/supabase/server";
import { decodeCodeParam } from "@/lib/validation/locations";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { getLocationByCode } from "@/server/locations";

// Dla skanera: kod z QR (trim + UPPERCASE; prefiks „L:” zdejmuje klient). Nieaktywna lokalizacja → 200
// z active:false (UI pokazuje ostrzeżenie); nieznany kod lub zepsute kodowanie → 404.
export async function GET(_request: Request, ctx: RouteContext<"/api/v1/locations/by-code/[code]">) {
  const auth = await requireApiRole();
  if (!auth.ok) return auth.response;

  // Kody nie zawierają „%”, więc ewentualne podwójne dekodowanie jest nieszkodliwe; zepsute kodowanie = 404.
  const code = decodeCodeParam((await ctx.params).code);
  if (code === null) return jsonError(404, "UNKNOWN_CODE", "Nieznany kod lokalizacji");

  const result = await getLocationByCode(await createSupabaseServerClient(), code);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data);
}
