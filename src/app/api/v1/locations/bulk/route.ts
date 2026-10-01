import { createSupabaseServerClient } from "@/lib/supabase/server";
import { bulkLocationsSchema } from "@/lib/validation/locations";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { createLocationsBulk } from "@/server/locations";
import { parseJsonBody } from "@/server/request";

// Dodawanie seryjne (max 200): wszystkie albo żadna (jeden INSERT w jednej transakcji).
export async function POST(request: Request) {
  const auth = await requireApiRole("ADMIN");
  if (!auth.ok) return auth.response;

  const body = await parseJsonBody(request, bulkLocationsSchema);
  if (!body.ok) return body.response;

  const result = await createLocationsBulk(await createSupabaseServerClient(), body.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message, result.error.fields);
  return jsonOk(result.data, 201);
}
