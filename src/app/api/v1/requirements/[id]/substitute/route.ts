import { createSupabaseServerClient } from "@/lib/supabase/server";
import { entityIdSchema } from "@/lib/validation/catalog";
import { substituteRequirementSchema } from "@/lib/validation/requirements";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { parseJsonBody } from "@/server/request";
import { substituteRequirementItem } from "@/server/requirements";

// „Podmień” pozycję listy zapotrzebowania na odpowiednik (BIURO, ADMIN; Etap 12b). Baza atomowo wycofuje listę
// i tworzy poprawioną kopię. 201 — nowa lista, 200 — powtórzenie żądania (ten sam client_request_id).
export async function POST(request: Request, ctx: RouteContext<"/api/v1/requirements/[id]/substitute">) {
  const auth = await requireApiRole("ADMIN", "BIURO");
  if (!auth.ok) return auth.response;

  const id = entityIdSchema.safeParse((await ctx.params).id);
  if (!id.success) return jsonError(400, "VALIDATION", "Nieprawidłowy identyfikator listy");

  const body = await parseJsonBody(request, substituteRequirementSchema);
  if (!body.ok) return body.response;

  const result = await substituteRequirementItem(await createSupabaseServerClient(), id.data, body.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data, result.data.idempotentReplay ? 200 : 201);
}
