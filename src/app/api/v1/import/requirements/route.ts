import { createSupabaseServerClient } from "@/lib/supabase/server";
import { importRequirementSchema } from "@/lib/validation/import";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { importRequirement } from "@/server/import";
import { parseJsonBody } from "@/server/request";

// Zapis listy zapotrzebowania z importu LiczOkno (BIURO, ADMIN): do istniejącego zlecenia (`order_id`) albo nowe
// zlecenie + lista atomowo (`new_order`). Plik jest parsowany w przeglądarce — tu trafia znormalizowany JSON.
// 201 (nowa lista) / 200 (powtórzenie z tym samym client_request_id).
export async function POST(request: Request) {
  const auth = await requireApiRole("ADMIN", "BIURO");
  if (!auth.ok) return auth.response;

  const body = await parseJsonBody(request, importRequirementSchema);
  if (!body.ok) return body.response;

  const result = await importRequirement(await createSupabaseServerClient(), body.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data, result.data.idempotentReplay ? 200 : 201);
}
