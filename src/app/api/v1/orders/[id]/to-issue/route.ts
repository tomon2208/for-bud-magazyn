import { createSupabaseServerClient } from "@/lib/supabase/server";
import { entityIdSchema } from "@/lib/validation/catalog";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { getOrderToIssue } from "@/server/requirements";

// „Do wydania na to zlecenie” (terminal): pozycje zapotrzebowania z pozostało > 0 — PRODUKCJA, ADMIN.
export async function GET(_request: Request, ctx: RouteContext<"/api/v1/orders/[id]/to-issue">) {
  const auth = await requireApiRole("PRODUKCJA", "ADMIN");
  if (!auth.ok) return auth.response;

  const id = entityIdSchema.safeParse((await ctx.params).id);
  if (!id.success) return jsonError(400, "VALIDATION", "Nieprawidłowy identyfikator zlecenia");

  const result = await getOrderToIssue(await createSupabaseServerClient(), id.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data);
}
