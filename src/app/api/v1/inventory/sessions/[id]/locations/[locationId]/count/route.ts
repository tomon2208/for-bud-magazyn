import { createSupabaseServerClient } from "@/lib/supabase/server";
import { entityIdSchema } from "@/lib/validation/catalog";
import { saveCountSchema } from "@/lib/validation/inventory";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { saveLocationCount } from "@/server/inventory";
import { parseJsonBody } from "@/server/request";

// Zapis liczenia lokalizacji (PRODUKCJA, ADMIN) — wszystkie pozycje naraz; ponowny zapis nadpisuje liczenie
// (to nie jest ruch magazynowy). Odpowiedź bez stanów systemowych.
export async function POST(request: Request, ctx: RouteContext<"/api/v1/inventory/sessions/[id]/locations/[locationId]/count">) {
  const auth = await requireApiRole("ADMIN", "PRODUKCJA");
  if (!auth.ok) return auth.response;

  const params = await ctx.params;
  const id = entityIdSchema.safeParse(params.id);
  const locationId = entityIdSchema.safeParse(params.locationId);
  if (!id.success || !locationId.success) return jsonError(400, "VALIDATION", "Nieprawidłowy identyfikator sesji lub lokalizacji");

  const body = await parseJsonBody(request, saveCountSchema);
  if (!body.ok) return body.response;

  const result = await saveLocationCount(await createSupabaseServerClient(), id.data, locationId.data, body.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message, undefined, result.error.details);
  return jsonOk(result.data, result.data.idempotentReplay ? 200 : 201);
}
