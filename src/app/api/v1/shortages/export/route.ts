import { CSV_BOM } from "@/lib/csv";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { shortagesQuerySchema } from "@/lib/validation/requirements";
import { requireApiRole } from "@/server/auth";
import { jsonError } from "@/server/http";
import { parseQuery } from "@/server/request";
import { exportShortagesCsv } from "@/server/requirements";

// Eksport braków do CSV (ADMIN, BIURO) — ten sam format co eksport stanów (UTF-8 z BOM, średnik, przecinek
// dziesiętny). Treść buduje funkcja SQL export_shortages_csv; Worker dokleja tylko BOM.
export async function GET(request: Request) {
  const auth = await requireApiRole("ADMIN", "BIURO");
  if (!auth.ok) return auth.response;

  const query = parseQuery(request.url, shortagesQuerySchema);
  if (!query.ok) return query.response;

  const result = await exportShortagesCsv(await createSupabaseServerClient(), query.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);

  return new Response(CSV_BOM + result.data.body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${result.data.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
