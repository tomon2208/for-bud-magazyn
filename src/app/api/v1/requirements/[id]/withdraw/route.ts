import { createSupabaseServerClient } from "@/lib/supabase/server";
import { entityIdSchema } from "@/lib/validation/catalog";
import { withdrawRequirementSchema } from "@/lib/validation/requirements";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { parseJsonBody } from "@/server/request";
import { withdrawRequirement } from "@/server/requirements";

// Wycofanie listy zapotrzebowania z powodem (BIURO, ADMIN). Lista nie jest usuwana ani edytowana.
export async function POST(request: Request, ctx: RouteContext<"/api/v1/requirements/[id]/withdraw">) {
  const auth = await requireApiRole("ADMIN", "BIURO");
  if (!auth.ok) return auth.response;

  const id = entityIdSchema.safeParse((await ctx.params).id);
  if (!id.success) return jsonError(400, "VALIDATION", "Nieprawidłowy identyfikator listy");

  const body = await parseJsonBody(request, withdrawRequirementSchema);
  if (!body.ok) return body.response;

  const result = await withdrawRequirement(await createSupabaseServerClient(), id.data, body.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data);
}
