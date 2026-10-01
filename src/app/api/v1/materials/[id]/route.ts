import { createSupabaseServerClient } from "@/lib/supabase/server";
import { entityIdSchema, updateMaterialSchema } from "@/lib/validation/catalog";
import { requireApiRole } from "@/server/auth";
import { getMaterial, updateMaterial } from "@/server/catalog";
import { jsonError, jsonOk } from "@/server/http";
import { parseJsonBody } from "@/server/request";

export async function GET(_request: Request, ctx: RouteContext<"/api/v1/materials/[id]">) {
  const auth = await requireApiRole();
  if (!auth.ok) return auth.response;

  const id = entityIdSchema.safeParse((await ctx.params).id);
  if (!id.success) return jsonError(400, "VALIDATION", "Nieprawidłowy identyfikator materiału");

  const result = await getMaterial(await createSupabaseServerClient(), id.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data);
}

export async function PATCH(request: Request, ctx: RouteContext<"/api/v1/materials/[id]">) {
  const auth = await requireApiRole("ADMIN");
  if (!auth.ok) return auth.response;

  const id = entityIdSchema.safeParse((await ctx.params).id);
  if (!id.success) return jsonError(400, "VALIDATION", "Nieprawidłowy identyfikator materiału");

  const body = await parseJsonBody(request, updateMaterialSchema);
  if (!body.ok) return body.response;

  const result = await updateMaterial(await createSupabaseServerClient(), id.data, body.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data);
}
