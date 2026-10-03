import { createSupabaseServerClient } from "@/lib/supabase/server";
import { entityIdSchema } from "@/lib/validation/catalog";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { getSessionEvents, getSessionOverview, getSessionReview } from "@/server/inventory";

// Szczegóły sesji. Dwa warianty (liczenie na ślepo, ADR 015):
// * PRODUKCJA — nagłówek i lokalizacje z postępem, BEZ stanów systemowych i różnic,
// * BIURO / ADMIN — dodatkowo tabela zatwierdzania (stan systemowy, policzono, różnica, status) i historia liczeń.
export async function GET(_request: Request, ctx: RouteContext<"/api/v1/inventory/sessions/[id]">) {
  const auth = await requireApiRole();
  if (!auth.ok) return auth.response;

  const id = entityIdSchema.safeParse((await ctx.params).id);
  if (!id.success) return jsonError(400, "VALIDATION", "Nieprawidłowy identyfikator sesji");

  const db = await createSupabaseServerClient();
  const overview = await getSessionOverview(db, id.data);
  if (!overview.ok) return jsonError(overview.error.status, overview.error.code, overview.error.message);
  if (auth.user.role === "PRODUKCJA") return jsonOk(overview.data);

  const [rows, events] = await Promise.all([getSessionReview(db, id.data), getSessionEvents(db, id.data)]);
  if (!rows.ok) return jsonError(rows.error.status, rows.error.code, rows.error.message);
  if (!events.ok) return jsonError(events.error.status, events.error.code, events.error.message);
  return jsonOk({ ...overview.data, rows: rows.data, events: events.data });
}
