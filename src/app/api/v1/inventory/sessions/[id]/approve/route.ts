import { createSupabaseServerClient } from "@/lib/supabase/server";
import { entityIdSchema } from "@/lib/validation/catalog";
import { approveSchema } from "@/lib/validation/inventory";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { approveInventory } from "@/server/inventory";
import { parseJsonBody } from "@/server/request";

// Zatwierdzenie różnic (BIURO, ADMIN — świadomy wyjątek od „BIURO bez korekt”, ROLES.md): operacja INVENTORY
// z ruchami różnic; pozycje z ruchem po liczeniu → „do ponownego policzenia”.
export async function POST(request: Request, ctx: RouteContext<"/api/v1/inventory/sessions/[id]/approve">) {
  const auth = await requireApiRole("ADMIN", "BIURO");
  if (!auth.ok) return auth.response;

  const id = entityIdSchema.safeParse((await ctx.params).id);
  if (!id.success) return jsonError(400, "VALIDATION", "Nieprawidłowy identyfikator sesji");

  const body = await parseJsonBody(request, approveSchema);
  if (!body.ok) return body.response;

  const result = await approveInventory(await createSupabaseServerClient(), id.data, body.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message, undefined, result.error.details);
  return jsonOk(result.data, result.data.idempotentReplay ? 200 : 201);
}
