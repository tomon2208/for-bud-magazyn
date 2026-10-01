import { updateUserSchema, userIdSchema } from "@/lib/validation/auth";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { parseJsonBody } from "@/server/request";
import { updateUser } from "@/server/users";

export async function PATCH(request: Request, ctx: RouteContext<"/api/v1/admin/users/[id]">) {
  const auth = await requireApiRole("ADMIN");
  if (!auth.ok) return auth.response;

  const { id } = await ctx.params;
  const parsedId = userIdSchema.safeParse(id);
  if (!parsedId.success) {
    return jsonError(400, "VALIDATION", "Nieprawidłowy identyfikator użytkownika");
  }

  const body = await parseJsonBody(request, updateUserSchema);
  if (!body.ok) return body.response;

  const result = await updateUser(auth.user.id, parsedId.data, body.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data);
}
