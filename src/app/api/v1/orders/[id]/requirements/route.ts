import { createSupabaseServerClient } from "@/lib/supabase/server";
import { entityIdSchema } from "@/lib/validation/catalog";
import { createRequirementSchema } from "@/lib/validation/requirements";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { parseJsonBody } from "@/server/request";
import { createRequirement, listRequirements } from "@/server/requirements";

// Listy zapotrzebowania zlecenia: odczyt — wszyscy aktywni; tworzenie — BIURO, ADMIN (jedna transakcja w bazie,
// listy niezmienne — poprawka = wycofanie + nowa lista).
export async function GET(_request: Request, ctx: RouteContext<"/api/v1/orders/[id]/requirements">) {
  const auth = await requireApiRole();
  if (!auth.ok) return auth.response;

  const id = entityIdSchema.safeParse((await ctx.params).id);
  if (!id.success) return jsonError(400, "VALIDATION", "Nieprawidłowy identyfikator zlecenia");

  const result = await listRequirements(await createSupabaseServerClient(), id.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data);
}

export async function POST(request: Request, ctx: RouteContext<"/api/v1/orders/[id]/requirements">) {
  const auth = await requireApiRole("ADMIN", "BIURO");
  if (!auth.ok) return auth.response;

  const id = entityIdSchema.safeParse((await ctx.params).id);
  if (!id.success) return jsonError(400, "VALIDATION", "Nieprawidłowy identyfikator zlecenia");

  const body = await parseJsonBody(request, createRequirementSchema);
  if (!body.ok) return body.response;

  const result = await createRequirement(await createSupabaseServerClient(), id.data, body.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data, result.data.idempotentReplay ? 200 : 201);
}
