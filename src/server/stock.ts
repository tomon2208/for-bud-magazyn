import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildIlikeContainsValue } from "@/lib/validation/catalog";
import type { ListMovementsQuery, ListStockQuery, ReceiptInput } from "@/lib/validation/stock";
import type { ServiceError, ServiceResult } from "./users";

// Serwis stocku. Stan zmienia wyłącznie funkcja DB (rpc) wywoływana klientem UŻYTKOWNIKA (auth.uid() = autor
// ruchu); rolę sprawdza route handler (requireApiRole) i ponownie funkcja DB.

type Db = SupabaseClient;
type DbError = { code?: string; message?: string; hint?: string | null; details?: string | null };

const INTERNAL: ServiceError = { status: 500, code: "INTERNAL", message: "Wystąpił błąd serwera. Spróbuj ponownie." };

const HINTS: Record<string, ServiceError> = {
  MATERIAL_INACTIVE: { status: 400, code: "MATERIAL_INACTIVE", message: "Materiał jest nieaktywny" },
  LOCATION_INACTIVE: { status: 400, code: "LOCATION_INACTIVE", message: "Lokalizacja jest nieaktywna" },
  SUPPLIER_INACTIVE: { status: 400, code: "SUPPLIER_INACTIVE", message: "Dostawca jest nieaktywny" },
  NOT_INTEGER: {
    status: 400,
    code: "NOT_INTEGER",
    message: "Ten materiał przyjmuje się w całych jednostkach (bez ułamków)",
  },
  INVALID_QUANTITY: {
    status: 400,
    code: "INVALID_QUANTITY",
    message: "Ilość musi być większa od zera, maksymalnie 1 000 000, do 3 miejsc po przecinku",
  },
  VALIDATION: { status: 400, code: "VALIDATION", message: "Nieprawidłowe dane" },
  IDEMPOTENCY_CONFLICT: {
    status: 409,
    code: "IDEMPOTENCY_CONFLICT",
    message: "Ten identyfikator żądania został już użyty dla innej operacji. Odśwież ekran i spróbuj ponownie.",
  },
};

const NOT_FOUND_MESSAGES: Record<string, string> = {
  material: "Nie znaleziono materiału",
  location: "Nie znaleziono lokalizacji",
  supplier: "Nie znaleziono dostawcy",
};

/** Mapowanie błędów funkcji stockowych na błędy API (bez ujawniania szczegółów bazy). */
export function mapStockError(error: DbError, context: string): ServiceError {
  if (error.code === "42501") return { status: 403, code: "FORBIDDEN", message: "Brak uprawnień" };
  if (error.code === "P0001" && error.hint) {
    if (error.hint === "NOT_FOUND") {
      return {
        status: 404,
        code: "NOT_FOUND",
        message: NOT_FOUND_MESSAGES[error.details ?? ""] ?? "Nie znaleziono",
      };
    }
    const mapped = HINTS[error.hint];
    if (mapped) return mapped;
  }
  // unique(client_request_id) — możliwe tylko poza READ COMMITTED; ponowienie zwróci istniejący wynik.
  if (error.code === "23505") {
    return { status: 409, code: "RETRY", message: "Operacja jest w toku. Spróbuj ponownie za chwilę." };
  }
  if (error.code === "22003") {
    return { status: 400, code: "STOCK_LIMIT", message: "Przekroczono maksymalny stan w lokalizacji" };
  }
  if (error.code === "22P02" || error.code === "23514") {
    return { status: 400, code: "VALIDATION", message: "Nieprawidłowe dane" };
  }
  console.error(context, error.code ?? "unknown");
  return INTERNAL;
}

// ---------------------------------------------------------------------------
// Przyjęcie
// ---------------------------------------------------------------------------
export type ReceiptResultDto = {
  operationId: string;
  movementId: string;
  materialId: string;
  locationId: string;
  quantity: number;
  newLocationQuantity: number;
  idempotentReplay: boolean;
};

type ReceiptRpcResult = {
  operation_id: string;
  movement_id: string;
  material_id: string;
  location_id: string;
  quantity: number | string;
  new_location_quantity: number | string;
  idempotent_replay: boolean;
};

export async function createReceipt(db: Db, input: ReceiptInput): Promise<ServiceResult<ReceiptResultDto>> {
  const { data, error } = await db.rpc("stock_receipt", {
    p_client_request_id: input.client_request_id,
    p_location_id: input.location_id,
    p_material_id: input.material_id,
    p_quantity: input.quantity,
    p_supplier_id: input.supplier_id ?? null,
    p_document_ref: input.document_ref ?? null,
    p_note: input.note ?? null,
  });
  if (error || !data) return { ok: false, error: mapStockError(error ?? {}, "createReceipt") };
  const r = data as ReceiptRpcResult;
  return {
    ok: true,
    data: {
      operationId: r.operation_id,
      movementId: r.movement_id,
      materialId: r.material_id,
      locationId: r.location_id,
      quantity: Number(r.quantity),
      newLocationQuantity: Number(r.new_location_quantity),
      idempotentReplay: r.idempotent_replay === true,
    },
  };
}

// ---------------------------------------------------------------------------
// Stany
// ---------------------------------------------------------------------------
export type StockRowDto = {
  materialId: string;
  materialCode: string;
  materialName: string;
  unit: string;
  allowsFraction: boolean;
  materialActive: boolean;
  locationId: string;
  locationCode: string;
  locationName: string | null;
  locationActive: boolean;
  quantity: number;
  updatedAt: string;
};
type StockRow = {
  material_id: string;
  material_code: string;
  material_name: string;
  unit: string;
  allows_fraction: boolean;
  material_active: boolean;
  location_id: string;
  location_code: string;
  location_name: string | null;
  location_active: boolean;
  quantity: number | string;
  updated_at: string;
};
const STOCK_COLUMNS =
  "material_id, material_code, material_name, unit, allows_fraction, material_active, location_id, location_code, location_name, location_active, quantity, updated_at";

const toStockRow = (r: StockRow): StockRowDto => ({
  materialId: r.material_id,
  materialCode: r.material_code,
  materialName: r.material_name,
  unit: r.unit,
  allowsFraction: r.allows_fraction,
  materialActive: r.material_active,
  locationId: r.location_id,
  locationCode: r.location_code,
  locationName: r.location_name,
  locationActive: r.location_active,
  quantity: Number(r.quantity),
  updatedAt: r.updated_at,
});

export type StockPage = { items: StockRowDto[]; total: number; page: number; pageSize: number };

/** Stany > 0 (wiersze z zerem zostają w tabeli, ale ich nie pokazujemy). Sortowanie: materiał, lokalizacja. */
export async function listStock(db: Db, q: ListStockQuery): Promise<ServiceResult<StockPage>> {
  let query = db
    .from("v_stock")
    .select(STOCK_COLUMNS, { count: "exact" })
    .gt("quantity", 0)
    .order("material_code", { ascending: true })
    .order("location_code", { ascending: true });
  if (q.locationId) query = query.eq("location_id", q.locationId);
  if (q.materialId) query = query.eq("material_id", q.materialId);
  if (q.q) {
    const pattern = buildIlikeContainsValue(q.q);
    query = query.or(`material_code.ilike.${pattern},material_name.ilike.${pattern},location_code.ilike.${pattern}`);
  }
  const from = (q.page - 1) * q.pageSize;
  const { data, error, count } = await query.range(from, from + q.pageSize - 1);
  if (error) {
    if (error.code === "PGRST103") return { ok: true, data: { items: [], total: 0, page: q.page, pageSize: q.pageSize } };
    return { ok: false, error: mapStockError(error, "listStock") };
  }
  return {
    ok: true,
    data: { items: (data as StockRow[]).map(toStockRow), total: count ?? 0, page: q.page, pageSize: q.pageSize },
  };
}

// ---------------------------------------------------------------------------
// Lista ruchów (Przyjęcia; historia w Etapie 6)
// ---------------------------------------------------------------------------
export type MovementDto = {
  movementId: string;
  operationId: string;
  type: string;
  createdAt: string;
  quantityDelta: number;
  materialId: string;
  materialCode: string;
  materialName: string;
  unit: string;
  locationId: string;
  locationCode: string;
  userName: string;
  supplierName: string | null;
  documentRef: string | null;
  note: string | null;
  reason: string | null;
};
type MovementRow = {
  movement_id: string;
  operation_id: string;
  type: string;
  created_at: string;
  quantity_delta: number | string;
  material_id: string;
  material_code: string;
  material_name: string;
  unit: string;
  location_id: string;
  location_code: string;
  user_name: string;
  supplier_name: string | null;
  document_ref: string | null;
  note: string | null;
  reason: string | null;
};

export type MovementPage = { items: MovementDto[]; total: number; page: number; pageSize: number };

/** PRODUKCJA dostaje wyłącznie własne ruchy (wymusza funkcja DB). `since` — np. ostatnie 24 h na terminalu. */
export async function listMovements(
  db: Db,
  q: ListMovementsQuery,
  opts: { since?: string } = {},
): Promise<ServiceResult<MovementPage>> {
  const { data, error } = await db.rpc("list_stock_movements", {
    p_type: q.type ?? null,
    p_material_q: q.q ?? null,
    p_date_from: q.from ?? null,
    p_date_to: q.to ?? null,
    p_page: q.page,
    p_page_size: q.pageSize,
    p_since: opts.since ?? null,
  });
  if (error || !data) return { ok: false, error: mapStockError(error ?? {}, "listMovements") };
  const result = data as { total: number; items: MovementRow[] };
  return {
    ok: true,
    data: {
      total: Number(result.total),
      page: q.page,
      pageSize: q.pageSize,
      items: result.items.map((r) => ({
        movementId: r.movement_id,
        operationId: r.operation_id,
        type: r.type,
        createdAt: r.created_at,
        quantityDelta: Number(r.quantity_delta),
        materialId: r.material_id,
        materialCode: r.material_code,
        materialName: r.material_name,
        unit: r.unit,
        locationId: r.location_id,
        locationCode: r.location_code,
        userName: r.user_name,
        supplierName: r.supplier_name,
        documentRef: r.document_ref,
        note: r.note,
        reason: r.reason,
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Moje ostatnie przyjęcia (terminal) — RLS: PRODUKCJA widzi tylko własne ruchy; filtr user_id dla każdej roli.
// ---------------------------------------------------------------------------
export type MyReceiptDto = {
  movementId: string;
  createdAt: string;
  quantity: number;
  materialCode: string;
  materialName: string;
  unit: string;
  locationCode: string;
};
type MyReceiptRow = {
  id: string;
  created_at: string;
  quantity_delta: number | string;
  material: { code: string; name: string; unit: string } | null;
  location: { code: string } | null;
};

export async function listMyRecentReceipts(
  db: Db,
  userId: string,
  opts: { since: string; limit?: number },
): Promise<ServiceResult<MyReceiptDto[]>> {
  const { data, error } = await db
    .from("stock_movements")
    .select(
      "id, created_at, quantity_delta, material:materials(code, name, unit), location:locations(code), operation:stock_operations!inner(type)",
    )
    .eq("user_id", userId)
    .eq("operation.type", "RECEIPT")
    .gte("created_at", opts.since)
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 10);
  if (error) return { ok: false, error: mapStockError(error, "listMyRecentReceipts") };
  return {
    ok: true,
    data: (data as unknown as MyReceiptRow[]).map((r) => ({
      movementId: r.id,
      createdAt: r.created_at,
      quantity: Number(r.quantity_delta),
      materialCode: r.material?.code ?? "",
      materialName: r.material?.name ?? "",
      unit: r.material?.unit ?? "",
      locationCode: r.location?.code ?? "",
    })),
  };
}

// ---------------------------------------------------------------------------
// Ostatnio przyjmowane materiały użytkownika (terminal: szybki wybór)
// ---------------------------------------------------------------------------
export type RecentMaterialDto = {
  id: string;
  code: string;
  name: string;
  unit: string;
  allowsFraction: boolean;
  defaultSupplierId: string | null;
};
type RecentRow = {
  material: {
    id: string;
    code: string;
    name: string;
    unit: string;
    allows_fraction: boolean;
    active: boolean;
    default_supplier_id: string | null;
  } | null;
  operation: { type: string; user_id: string } | null;
};

/** Do `limit` różnych aktywnych materiałów z ostatnich przyjęć użytkownika (najnowsze pierwsze). */
export async function listRecentReceiptMaterials(
  db: Db,
  userId: string,
  limit = 5,
): Promise<ServiceResult<RecentMaterialDto[]>> {
  const { data, error } = await db
    .from("stock_movements")
    .select(
      "material:materials(id, code, name, unit, allows_fraction, active, default_supplier_id), operation:stock_operations!inner(type, user_id)",
    )
    .eq("user_id", userId)
    .eq("operation.type", "RECEIPT")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return { ok: false, error: mapStockError(error, "listRecentReceiptMaterials") };
  const seen = new Set<string>();
  const items: RecentMaterialDto[] = [];
  for (const row of data as unknown as RecentRow[]) {
    const m = row.material;
    if (!m || !m.active || seen.has(m.id)) continue;
    seen.add(m.id);
    items.push({
      id: m.id,
      code: m.code,
      name: m.name,
      unit: m.unit,
      allowsFraction: m.allows_fraction,
      defaultSupplierId: m.default_supplier_id,
    });
    if (items.length >= limit) break;
  }
  return { ok: true, data: items };
}
