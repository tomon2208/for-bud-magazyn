import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createOrderSchema, listOrdersQuerySchema } from "@/lib/validation/orders";
import { requireApiRole } from "@/server/auth";
import { jsonError, jsonOk } from "@/server/http";
import { createOrder, listOrders } from "@/server/orders";
import { parseJsonBody, parseQuery } from "@/server/request";

// Zlecenia: odczyt — wszyscy aktywni (PRODUKCJA wybiera zlecenie przy wydaniu); zapis — BIURO, ADMIN.
export async function GET(request: Request) {
  const auth = await requireApiRole();
  if (!auth.ok) return auth.response;

  const query = parseQuery(request.url, listOrdersQuerySchema);
  if (!query.ok) return query.response;

  const result = await listOrders(await createSupabaseServerClient(), query.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data);
}

export async function POST(request: Request) {
  const auth = await requireApiRole("ADMIN", "BIURO");
  if (!auth.ok) return auth.response;

  const body = await parseJsonBody(request, createOrderSchema);
  if (!body.ok) return body.response;

  const result = await createOrder(await createSupabaseServerClient(), body.data);
  if (!result.ok) return jsonError(result.error.status, result.error.code, result.error.message);
  return jsonOk(result.data, 201);
}
