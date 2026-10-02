import { createSupabaseServerClient } from "@/lib/supabase/server";
import { entityIdSchema } from "@/lib/validation/catalog";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { getOrderShortages } from "@/server/requirements";

// Braki jednego zlecenia (potrzebne / wydano / pozostało / dostępne / brakuje) — BIURO, ADMIN.
// „Dostępne” jest wspólne dla wszystkich zleceń; prawdziwe braki do zamówienia pokazuje GET /api/v1/shortages.
export async function GET(_request: Request, ctx: RouteContext<"/api/v1/orders/[id]/shortages">) {
  const auth = await requireApiRole("ADMIN", "BIURO");
  if (!auth.ok) return auth.response;

  const id = entityIdSchema.safeParse((await ctx.params).id);
  if (!id.success) return jsonError(400, "VALIDATION", "Nieprawidłowy identyfikator zlecenia");

  const result = await getOrderShortages(await createSupabaseServerClient(), id.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data);
}
