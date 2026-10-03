import { CSV_BOM } from "@/lib/csv";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { entityIdSchema } from "@/lib/validation/catalog";
import { exportInventoryQuerySchema } from "@/lib/validation/inventory";
import { requireApiRole } from "@/server/auth";
import { jsonError } from "@/server/http";
import { exportInventoryCsv } from "@/server/inventory";
import { parseQuery } from "@/server/request";

// Eksport CSV pozycji sesji (BIURO, ADMIN) — ?onlyDiff=true: tylko różnice / do ponownego policzenia / niepoliczone.
// Treść buduje funkcja SQL export_inventory_csv (format jak inne eksporty); Worker dokleja BOM.
export async function GET(request: Request, ctx: RouteContext<"/api/v1/inventory/sessions/[id]/export">) {
  const auth = await requireApiRole("ADMIN", "BIURO");
  if (!auth.ok) return auth.response;

  const id = entityIdSchema.safeParse((await ctx.params).id);
  if (!id.success) return jsonError(400, "VALIDATION", "Nieprawidłowy identyfikator sesji");

  const query = parseQuery(request.url, exportInventoryQuerySchema);
  if (!query.ok) return query.response;

  const result = await exportInventoryCsv(await createSupabaseServerClient(), id.data, query.data.onlyDiff ?? false);
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
