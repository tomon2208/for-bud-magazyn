import { createSupabaseServerClient } from "@/lib/supabase/server";
import { entityIdSchema } from "@/lib/validation/catalog";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { deleteImportAlias } from "@/server/import";
import { guardMutation } from "@/server/request";

// Usunięcie powiązania / oznaczenia „nie magazynujemy” (BIURO, ADMIN). To konfiguracja, nie historia ruchów.
export async function DELETE(request: Request, ctx: RouteContext<"/api/v1/import/aliases/[id]">) {
  const auth = await requireApiRole("ADMIN", "BIURO");
  if (!auth.ok) return auth.response;

  const csrf = guardMutation(request);
  if (csrf) return csrf;

  const id = entityIdSchema.safeParse((await ctx.params).id);
  if (!id.success) return jsonError(400, "VALIDATION", "Nieprawidłowy identyfikator powiązania");

  const result = await deleteImportAlias(await createSupabaseServerClient(), id.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data);
}
