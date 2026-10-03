import { createSupabaseServerClient } from "@/lib/supabase/server";
import { upsertAliasSchema } from "@/lib/validation/import";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { listImportAliases, upsertImportAlias } from "@/server/import";
import { parseJsonBody } from "@/server/request";

// Powiązania kodów z pliku LiczOkno z materiałami i lista „nie magazynujemy” (BIURO, ADMIN).
export async function GET() {
  const auth = await requireApiRole("ADMIN", "BIURO");
  if (!auth.ok) return auth.response;

  const result = await listImportAliases(await createSupabaseServerClient());
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data);
}

// Upsert po kodzie: { source_code, action: MAP + material_id | IGNORE }.
export async function PUT(request: Request) {
  const auth = await requireApiRole("ADMIN", "BIURO");
  if (!auth.ok) return auth.response;

  const body = await parseJsonBody(request, upsertAliasSchema);
  if (!body.ok) return body.response;

  const result = await upsertImportAlias(await createSupabaseServerClient(), body.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data);
}
