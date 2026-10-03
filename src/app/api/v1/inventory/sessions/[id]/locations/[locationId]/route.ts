import { createSupabaseServerClient } from "@/lib/supabase/server";
import { entityIdSchema } from "@/lib/validation/catalog";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { getCountingLocation } from "@/server/inventory";

// Ekran liczenia lokalizacji (PRODUKCJA, ADMIN): materiały oczekiwane BEZ ilości, wpisane liczenia, czas serwera
// (znacznik rozpoczęcia liczenia). Bez stanów systemowych i różnic (liczenie na ślepo).
export async function GET(_request: Request, ctx: RouteContext<"/api/v1/inventory/sessions/[id]/locations/[locationId]">) {
  const auth = await requireApiRole("ADMIN", "PRODUKCJA");
  if (!auth.ok) return auth.response;

  const params = await ctx.params;
  const id = entityIdSchema.safeParse(params.id);
  const locationId = entityIdSchema.safeParse(params.locationId);
  if (!id.success || !locationId.success) return jsonError(400, "VALIDATION", "Nieprawidłowy identyfikator sesji lub lokalizacji");

  const result = await getCountingLocation(await createSupabaseServerClient(), id.data, locationId.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data);
}
