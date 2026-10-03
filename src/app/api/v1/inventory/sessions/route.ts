import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSessionSchema, listSessionsQuerySchema } from "@/lib/validation/inventory";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { createInventorySession, listInventorySessions } from "@/server/inventory";
import { parseJsonBody, parseQuery } from "@/server/request";

// Sesje inwentaryzacji (Etap 13, ADR 015): GET — lista z postępem (każda aktywna rola; bez stanów systemowych),
// POST — utworzenie sesji (BIURO, ADMIN): wszystkie aktywne lokalizacje / prefiks kodu / zaznaczone.
export async function GET(request: Request) {
  const auth = await requireApiRole();
  if (!auth.ok) return auth.response;

  const query = parseQuery(request.url, listSessionsQuerySchema);
  if (!query.ok) return query.response;

  const result = await listInventorySessions(await createSupabaseServerClient(), query.data.status);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data);
}

export async function POST(request: Request) {
  const auth = await requireApiRole("ADMIN", "BIURO");
  if (!auth.ok) return auth.response;

  const body = await parseJsonBody(request, createSessionSchema);
  if (!body.ok) return body.response;

  const result = await createInventorySession(await createSupabaseServerClient(), body.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message, undefined, result.error.details);
  return jsonOk(result.data, result.data.idempotentReplay ? 200 : 201);
}
