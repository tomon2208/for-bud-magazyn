import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createUserSchema } from "@/lib/validation/auth";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { parseJsonBody } from "@/server/request";
import { createUser, listUsers } from "@/server/users";

export async function GET() {
  const auth = await requireApiRole("ADMIN");
  if (!auth.ok) return auth.response;

  const result = await listUsers(await createSupabaseServerClient());
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data);
}

export async function POST(request: Request) {
  const auth = await requireApiRole("ADMIN");
  if (!auth.ok) return auth.response;

  const body = await parseJsonBody(request, createUserSchema);
  if (!body.ok) return body.response;

  const result = await createUser(body.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data, 201);
}
