import { createSupabaseServerClient } from "@/lib/supabase/server";
import { entityIdSchema, updateSupplierSchema } from "@/lib/validation/catalog";
import { requireApiRole } from "@/server/auth";
import { updateSupplier } from "@/server/catalog";
import { jsonError, jsonOk } from "@/server/http";
import { parseJsonBody } from "@/server/request";

export async function PATCH(request: Request, ctx: RouteContext<"/api/v1/suppliers/[id]">) {
  const auth = await requireApiRole("ADMIN", "BIURO");
  if (!auth.ok) return auth.response;

  const id = entityIdSchema.safeParse((await ctx.params).id);
  if (!id.success) return jsonError(400, "VALIDATION", "Nieprawidłowy identyfikator dostawcy");

  const body = await parseJsonBody(request, updateSupplierSchema);
  if (!body.ok) return body.response;

  const result = await updateSupplier(await createSupabaseServerClient(), id.data, body.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data);
}
