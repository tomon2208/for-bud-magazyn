import { createSupabaseServerClient } from "@/lib/supabase/server";
import { entityIdSchema } from "@/lib/validation/catalog";
import { cancelSessionSchema } from "@/lib/validation/inventory";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { cancelInventorySession } from "@/server/inventory";
import { parseJsonBody } from "@/server/request";

// Anulowanie sesji (BIURO, ADMIN) — tylko bez zatwierdzonych pozycji.
export async function POST(request: Request, ctx: RouteContext<"/api/v1/inventory/sessions/[id]/cancel">) {
  const auth = await requireApiRole("ADMIN", "BIURO");
  if (!auth.ok) return auth.response;

  const id = entityIdSchema.safeParse((await ctx.params).id);
  if (!id.success) return jsonError(400, "VALIDATION", "Nieprawidłowy identyfikator sesji");

  const body = await parseJsonBody(request, cancelSessionSchema);
  if (!body.ok) return body.response;

  const result = await cancelInventorySession(await createSupabaseServerClient(), id.data, body.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data);
}
