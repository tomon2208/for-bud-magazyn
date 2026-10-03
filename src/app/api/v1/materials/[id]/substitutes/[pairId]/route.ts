import { createSupabaseServerClient } from "@/lib/supabase/server";
import { entityIdSchema } from "@/lib/validation/catalog";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { guardMutation } from "@/server/request";
import { removeMaterialSubstitute } from "@/server/substitutes";

// Usunięcie pary odpowiedników (ADMIN). Konfiguracja — rozliczenia wydań zamienników zostają w historii.
export async function DELETE(request: Request, ctx: RouteContext<"/api/v1/materials/[id]/substitutes/[pairId]">) {
  const auth = await requireApiRole("ADMIN");
  if (!auth.ok) return auth.response;

  const csrf = guardMutation(request);
  if (csrf) return csrf;

  const params = await ctx.params;
  const id = entityIdSchema.safeParse(params.id);
  const pairId = entityIdSchema.safeParse(params.pairId);
  if (!id.success || !pairId.success) return jsonError(400, "VALIDATION", "Nieprawidłowy identyfikator");

  const result = await removeMaterialSubstitute(await createSupabaseServerClient(), pairId.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data);
}
