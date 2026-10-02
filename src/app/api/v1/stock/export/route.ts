import { CSV_BOM } from "@/lib/csv";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { exportStockQuerySchema } from "@/lib/validation/stock";
import { requireApiRole } from "@/server/auth";
import { jsonError } from "@/server/http";
import { exportStockCsv } from "@/server/overview";
import { parseQuery } from "@/server/request";

// Eksport stanów do CSV (ADMIN, BIURO) — UTF-8 z BOM, średnik, przecinek dziesiętny (polski Excel).
// Treść CSV buduje funkcja SQL export_stock_csv (Worker dokleja tylko BOM); filtry jak w widoku Magazyn.
export async function GET(request: Request) {
  const auth = await requireApiRole("ADMIN", "BIURO");
  if (!auth.ok) return auth.response;

  const query = parseQuery(request.url, exportStockQuerySchema);
  if (!query.ok) return query.response;

  const result = await exportStockCsv(await createSupabaseServerClient(), query.data);
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
