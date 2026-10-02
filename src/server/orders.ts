import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { likeContains } from "@/lib/validation/catalog";
import type { CreateOrderInput, ListOrdersQuery, OrderStatus, UpdateOrderInput } from "@/lib/validation/orders";
import type { ServiceError, ServiceResult } from "./users";

// Zlecenia produkcyjne. Operacje przez klienta UŻYTKOWNIKA (RLS + trigger roli = druga linia obrony);
// rolę sprawdzają route handlery (requireApiRole): zapis BIURO/ADMIN, odczyt wszyscy aktywni.

type Db = SupabaseClient;
type DbError = { code?: string; message?: string; hint?: string | null };

const INTERNAL: ServiceError = { status: 500, code: "INTERNAL", message: "Wystąpił błąd serwera. Spróbuj ponownie." };

export function mapOrderDbError(error: DbError, context: string): ServiceError {
  if (error.code === "42501") return { status: 403, code: "FORBIDDEN", message: "Brak uprawnień" };
  if (error.code === "23514" || error.code === "22P02" || error.code === "23502") {
    return { status: 400, code: "VALIDATION", message: "Nieprawidłowe dane" };
  }
  console.error(context, error.code ?? "unknown");
  return INTERNAL;
}

export type OrderDto = {
  id: string;
  name: string;
  notes: string | null;
  status: OrderStatus;
  createdAt: string;
  updatedAt: string;
};
type OrderRow = { id: string; name: string; notes: string | null; status: OrderStatus; created_at: string; updated_at: string };
const COLUMNS = "id, name, notes, status, created_at, updated_at";

const toOrder = (r: OrderRow): OrderDto => ({
  id: r.id,
  name: r.name,
  notes: r.notes,
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export type OrderPage = { items: OrderDto[]; total: number; page: number; pageSize: number };

/** Lista zleceń (najnowsze pierwsze); filtr statusu i nazwy (dosłowne „zawiera”). */
export async function listOrders(db: Db, q: ListOrdersQuery): Promise<ServiceResult<OrderPage>> {
  let query = db
    .from("production_orders")
    .select(COLUMNS, { count: "exact" })
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });
  if (q.status) query = query.eq("status", q.status);
  if (q.q) query = query.ilike("name", likeContains(q.q));
  const from = (q.page - 1) * q.pageSize;
  const { data, error, count } = await query.range(from, from + q.pageSize - 1);
  if (error) {
    if (error.code === "PGRST103") return { ok: true, data: { items: [], total: 0, page: q.page, pageSize: q.pageSize } };
    return { ok: false, error: mapOrderDbError(error, "listOrders") };
  }
  return {
    ok: true,
    data: { items: (data as OrderRow[]).map(toOrder), total: count ?? 0, page: q.page, pageSize: q.pageSize },
  };
}

export async function getOrder(db: Db, id: string): Promise<ServiceResult<OrderDto>> {
  const { data, error } = await db.from("production_orders").select(COLUMNS).eq("id", id).maybeSingle();
  if (error) return { ok: false, error: mapOrderDbError(error, "getOrder") };
  if (!data) return { ok: false, error: { status: 404, code: "NOT_FOUND", message: "Nie znaleziono zlecenia" } };
  return { ok: true, data: toOrder(data as OrderRow) };
}

export async function createOrder(db: Db, input: CreateOrderInput): Promise<ServiceResult<OrderDto>> {
  const { data, error } = await db.from("production_orders").insert(input).select(COLUMNS).single();
  if (error || !data) return { ok: false, error: mapOrderDbError(error ?? {}, "createOrder") };
  return { ok: true, data: toOrder(data as OrderRow) };
}

export async function updateOrder(db: Db, id: string, input: UpdateOrderInput): Promise<ServiceResult<OrderDto>> {
  const { data, error } = await db.from("production_orders").update(input).eq("id", id).select(COLUMNS).maybeSingle();
  if (error) return { ok: false, error: mapOrderDbError(error, "updateOrder") };
  if (!data) return { ok: false, error: { status: 404, code: "NOT_FOUND", message: "Nie znaleziono zlecenia" } };
  return { ok: true, data: toOrder(data as OrderRow) };
}

/**
 * Ostatnio używane przez użytkownika OTWARTE zlecenia (z jego wydań; najnowsze pierwsze). RLS: PRODUKCJA widzi
 * tylko własne operacje; filtr user_id dla każdej roli.
 */
export async function listRecentOrdersForUser(db: Db, userId: string, limit = 5): Promise<ServiceResult<OrderDto[]>> {
  const { data, error } = await db
    .from("stock_operations")
    .select(`order:production_orders!inner(${COLUMNS})`)
    .eq("user_id", userId)
    .eq("type", "ISSUE")
    .eq("order.status", "OPEN")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return { ok: false, error: mapOrderDbError(error, "listRecentOrdersForUser") };
  const seen = new Set<string>();
  const items: OrderDto[] = [];
  for (const row of data as unknown as { order: OrderRow | null }[]) {
    if (!row.order || seen.has(row.order.id)) continue;
    seen.add(row.order.id);
    items.push(toOrder(row.order));
    if (items.length >= limit) break;
  }
  return { ok: true, data: items };
}

export type OrderIssueSummaryDto = {
  materialId: string;
  materialCode: string;
  materialName: string;
  unit: string;
  /** Wydano netto (wydania pomniejszone o cofnięte). */
  quantity: number;
  issues: number;
  /** Liczba cofniętych wydań (storno). */
  reversals: number;
};
type SummaryRow = {
  material_id: string;
  material_code: string;
  material_name: string;
  unit: string;
  quantity: number | string;
  issues: number;
  reversals?: number;
};

/**
 * Podsumowanie wydań na zlecenie: suma ilości per materiał (wydania minus storna wydań — ADR 011), liczona w SQL (`order_issue_summary`, SECURITY
 * INVOKER — RLS: BIURO/ADMIN wszystkie operacje, PRODUKCJA tylko własne).
 */
export async function getOrderIssueSummary(db: Db, orderId: string): Promise<ServiceResult<OrderIssueSummaryDto[]>> {
  const { data, error } = await db.rpc("order_issue_summary", { p_order_id: orderId });
  if (error) return { ok: false, error: mapOrderDbError(error, "getOrderIssueSummary") };
  return {
    ok: true,
    data: ((data ?? []) as SummaryRow[]).map((r) => ({
      materialId: r.material_id,
      materialCode: r.material_code,
      materialName: r.material_name,
      unit: r.unit,
      quantity: Number(r.quantity),
      issues: Number(r.issues),
      reversals: Number(r.reversals ?? 0),
    })),
  };
}
