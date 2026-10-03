import { createSupabaseServerClient } from "@/lib/supabase/server";
import { addSubstituteSchema, entityIdSchema } from "@/lib/validation/catalog";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { parseJsonBody } from "@/server/request";
import { addMaterialSubstitute, listMaterialSubstitutes } from "@/server/substitutes";

// Odpowiedniki materiału (Etap 12b, ADR 017). Odczyt — każda aktywna rola; dodanie pary — ADMIN (jak kartoteka).
export async function GET(_request: Request, ctx: RouteContext<"/api/v1/materials/[id]/substitutes">) {
  const auth = await requireApiRole();
  if (!auth.ok) return auth.response;

  const id = entityIdSchema.safeParse((await ctx.params).id);
  if (!id.success) return jsonError(400, "VALIDATION", "Nieprawidłowy identyfikator materiału");

  const result = await listMaterialSubstitutes(await createSupabaseServerClient(), id.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk({ items: result.data });
}

export async function POST(request: Request, ctx: RouteContext<"/api/v1/materials/[id]/substitutes">) {
  const auth = await requireApiRole("ADMIN");
  if (!auth.ok) return auth.response;

  const id = entityIdSchema.safeParse((await ctx.params).id);
  if (!id.success) return jsonError(400, "VALIDATION", "Nieprawidłowy identyfikator materiału");

  const body = await parseJsonBody(request, addSubstituteSchema);
  if (!body.ok) return body.response;
  if (body.data.substitute_id === id.data) {
    return jsonError(400, "SAME_MATERIAL", "Materiał nie może być odpowiednikiem samego siebie");
  }

  const result = await addMaterialSubstitute(await createSupabaseServerClient(), id.data, body.data.substitute_id);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data, result.data.alreadyExisted ? 200 : 201);
}
