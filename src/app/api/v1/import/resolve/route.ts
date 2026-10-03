import { createSupabaseServerClient } from "@/lib/supabase/server";
import { resolveCodesSchema } from "@/lib/validation/import";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { resolveImportCodes } from "@/server/import";
import { parseJsonBody } from "@/server/request";

// Dopasowanie kodów z pliku LiczOkno do kartoteki (BIURO, ADMIN). POST, bo kodów jest do 1000 (nie mieszczą się w URL);
// operacja jest tylko do odczytu.
export async function POST(request: Request) {
  const auth = await requireApiRole("ADMIN", "BIURO");
  if (!auth.ok) return auth.response;

  const body = await parseJsonBody(request, resolveCodesSchema);
  if (!body.ok) return body.response;

  const result = await resolveImportCodes(await createSupabaseServerClient(), body.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data);
}
