import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createMaterialSchema, listMaterialsQuerySchema } from "@/lib/validation/catalog";
import { requireApiRole } from "@/server/auth";
import { createMaterial, listMaterials } from "@/server/catalog";
import { jsonError, jsonOk } from "@/server/http";
import { parseJsonBody, parseQuery } from "@/server/request";

export async function GET(request: Request) {
  const auth = await requireApiRole();
  if (!auth.ok) return auth.response;

  const query = parseQuery(request.url, listMaterialsQuerySchema);
  if (!query.ok) return query.response;

  const result = await listMaterials(await createSupabaseServerClient(), query.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data);
}

export async function POST(request: Request) {
  const auth = await requireApiRole("ADMIN");
  if (!auth.ok) return auth.response;

  const body = await parseJsonBody(request, createMaterialSchema);
  if (!body.ok) return body.response;

  const result = await createMaterial(await createSupabaseServerClient(), body.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data, 201);
}
