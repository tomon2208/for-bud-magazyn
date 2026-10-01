import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createLocationSchema, listLocationsQuerySchema } from "@/lib/validation/locations";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { createLocation, listLocations } from "@/server/locations";
import { parseJsonBody, parseQuery } from "@/server/request";

export async function GET(request: Request) {
  const auth = await requireApiRole();
  if (!auth.ok) return auth.response;

  const query = parseQuery(request.url, listLocationsQuerySchema);
  if (!query.ok) return query.response;

  const result = await listLocations(await createSupabaseServerClient(), query.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message, result.error.fields);
  return jsonOk(result.data);
}

export async function POST(request: Request) {
  const auth = await requireApiRole("ADMIN");
  if (!auth.ok) return auth.response;

  const body = await parseJsonBody(request, createLocationSchema);
  if (!body.ok) return body.response;

  const result = await createLocation(await createSupabaseServerClient(), body.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message, result.error.fields);
  return jsonOk(result.data, 201);
}
