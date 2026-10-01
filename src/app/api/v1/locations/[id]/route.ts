import { createSupabaseServerClient } from "@/lib/supabase/server";
import { entityIdSchema } from "@/lib/validation/catalog";
import { updateLocationSchema } from "@/lib/validation/locations";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { getLocation, updateLocation } from "@/server/locations";
import { parseJsonBody } from "@/server/request";

export async function GET(_request: Request, ctx: RouteContext<"/api/v1/locations/[id]">) {
  const auth = await requireApiRole();
  if (!auth.ok) return auth.response;

  const id = entityIdSchema.safeParse((await ctx.params).id);
  if (!id.success) return jsonError(400, "VALIDATION", "Nieprawidłowy identyfikator lokalizacji");

  const result = await getLocation(await createSupabaseServerClient(), id.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data);
}

export async function PATCH(request: Request, ctx: RouteContext<"/api/v1/locations/[id]">) {
  const auth = await requireApiRole("ADMIN");
  if (!auth.ok) return auth.response;

  const id = entityIdSchema.safeParse((await ctx.params).id);
  if (!id.success) return jsonError(400, "VALIDATION", "Nieprawidłowy identyfikator lokalizacji");

  const body = await parseJsonBody(request, updateLocationSchema);
  if (!body.ok) return body.response;

  const result = await updateLocation(await createSupabaseServerClient(), id.data, body.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data);
}
