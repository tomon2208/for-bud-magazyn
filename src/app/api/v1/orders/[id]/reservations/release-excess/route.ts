import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { entityIdSchema } from "@/lib/validation/catalog";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { parseJsonBody } from "@/server/request";
import { releaseReservationExcess } from "@/server/reservations";

const bodySchema = z.object({ client_request_id: z.uuid({ error: "Brak identyfikatora żądania" }) }).strict();

// „Zwolnij nadmiar” — rezerwacje ponad pozostało do wydania (np. po wycofaniu listy), powód automatyczny. BIURO, ADMIN.
export async function POST(request: Request, ctx: RouteContext<"/api/v1/orders/[id]/reservations/release-excess">) {
  const auth = await requireApiRole("ADMIN", "BIURO");
  if (!auth.ok) return auth.response;

  const id = entityIdSchema.safeParse((await ctx.params).id);
  if (!id.success) return jsonError(400, "VALIDATION", "Nieprawidłowy identyfikator zlecenia");

  const body = await parseJsonBody(request, bodySchema);
  if (!body.ok) return body.response;

  const result = await releaseReservationExcess(await createSupabaseServerClient(), id.data, body.data.client_request_id);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message, undefined, result.error.details);
  return jsonOk(result.data, result.data.idempotentReplay ? 200 : 201);
}
