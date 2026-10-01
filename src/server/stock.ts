import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildIlikeContainsValue } from "@/lib/validation/catalog";
import type {
  IssueInput,
  ListMovementsQuery,
  ListStockQuery,
  OperationType,
  ReceiptInput,
  TransferInput,
} from "@/lib/validation/stock";
import type { ServiceError, ServiceResult } from "./users";

// Serwis stocku. Stan zmienia wyłącznie funkcja DB (rpc) wywoływana klientem UŻYTKOWNIKA (auth.uid() = autor
// ruchu); rolę sprawdza route handler (requireApiRole) i ponownie funkcja DB.

type Db = SupabaseClient;
type DbError = { code?: string; message?: string; hint?: string | null; details?: string | null };

/** Błąd operacji stockowej; `details` — dane dla klienta (np. dostępna ilość przy INSUFFICIENT_STOCK). */
export type StockError = ServiceError & { details?: { available: number } };
export type StockResult<T> = { ok: true; data: T } | { ok: false; error: StockError };

const INTERNAL: ServiceError = { status: 500, code: "INTERNAL", message: "Wystąpił błąd serwera. Spróbuj ponownie." };

const HINTS: Record<string, ServiceError> = {
  MATERIAL_INACTIVE: { status: 400, code: "MATERIAL_INACTIVE", message: "Materiał jest nieaktywny" },
  LOCATION_INACTIVE: { status: 400, code: "LOCATION_INACTIVE", message: "Lokalizacja jest nieaktywna" },
  SUPPLIER_INACTIVE: { status: 400, code: "SUPPLIER_INACTIVE", message: "Dostawca jest nieaktywny" },
  NOT_INTEGER: {
    status: 400,
    code: "NOT_INTEGER",
    message: "Ten materiał liczy się w całych jednostkach (bez ułamków)",
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
  ISSUE_TARGET: { status: 400, code: "ISSUE_TARGET", message: "Wybierz zlecenie albo powód wydania (dokładnie jedno)" },
  REASON_REQUIRED: { status: 400, code: "REASON_REQUIRED", message: "Opisz powód wydania" },
  ORDER_NOT_OPEN: {
    status: 409,
    code: "ORDER_NOT_OPEN",
    message: "Zlecenie jest zamknięte (zakończone lub anulowane) — nie można na nie wydawać",
  },
  SAME_LOCATION: { status: 400, code: "SAME_LOCATION", message: "Lokalizacja docelowa musi być inna niż źródłowa" },
};

const NOT_FOUND_MESSAGES: Record<string, string> = {
  material: "Nie znaleziono materiału",
  location: "Nie znaleziono lokalizacji",
  supplier: "Nie znaleziono dostawcy",
  order: "Nie znaleziono zlecenia",
};

/** Mapowanie błędów funkcji stockowych na błędy API (bez ujawniania szczegółów bazy). */
export function mapStockError(error: DbError, context: string): StockError {
  if (error.code === "42501") return { status: 403, code: "FORBIDDEN", message: "Brak uprawnień" };
  if (error.code === "P0001" && error.hint) {
    if (error.hint === "NOT_FOUND") {
      return {
        status: 404,
        code: "NOT_FOUND",
        message: NOT_FOUND_MESSAGES[error.details ?? ""] ?? "Nie znaleziono",
      };
    }
    if (error.hint === "INSUFFICIENT_STOCK") {
      // detail = dostępna ilość w lokalizacji (tekst numeric z funkcji DB).
      const available = Number(error.details);
      const safe = Number.isFinite(available) && available >= 0 ? available : 0;
      return {
        status: 409,
        code: "INSUFFICIENT_STOCK",
        message: `Niewystarczający stan w lokalizacji. Dostępne: ${safe.toLocaleString("pl-PL", { maximumFractionDigits: 3 })}`,
        details: { available: safe },
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

export async function createReceipt(db: Db, input: ReceiptInput): Promise<StockResult<ReceiptResultDto>> {
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
// Wydanie
// ---------------------------------------------------------------------------
export type IssueResultDto = {
  operationId: string;
  movementId: string;
  materialId: string;
  locationId: string;
  quantity: number;
  productionOrderId: string | null;
  reasonCode: string | null;
  remainingLocationQuantity: number;
  idempotentReplay: boolean;
};

type IssueRpcResult = {
  operation_id: string;
  movement_id: string;
  material_id: string;
  location_id: string;
  quantity: number | string;
  production_order_id: string | null;
  reason_code: string | null;
  remaining_location_quantity: number | string;
  idempotent_replay: boolean;
};

export async function createIssue(db: Db, input: IssueInput): Promise<StockResult<IssueResultDto>> {
  const { data, error } = await db.rpc("stock_issue", {
    p_client_request_id: input.client_request_id,
    p_location_id: input.location_id,
    p_material_id: input.material_id,
    p_quantity: input.quantity,
    p_production_order_id: input.production_order_id ?? null,
    p_reason_code: input.reason_code ?? null,
    p_reason: input.reason ?? null,
    p_note: input.note ?? null,
  });
  if (error || !data) return { ok: false, error: mapStockError(error ?? {}, "createIssue") };
  const r = data as IssueRpcResult;
  return {
    ok: true,
    data: {
      operationId: r.operation_id,
      movementId: r.movement_id,
      materialId: r.material_id,
      locationId: r.location_id,
      quantity: Number(r.quantity),
      productionOrderId: r.production_order_id,
      reasonCode: r.reason_code,
      remainingLocationQuantity: Number(r.remaining_location_quantity),
      idempotentReplay: r.idempotent_replay === true,
    },
  };
}

// ---------------------------------------------------------------------------
// Przesunięcie
// ---------------------------------------------------------------------------
export type TransferResultDto = {
  operationId: string;
  materialId: string;
  fromLocationId: string;
  toLocationId: string;
  quantity: number;
  fromLocationQuantity: number;
  toLocationQuantity: number;
  idempotentReplay: boolean;
};

type TransferRpcResult = {
  operation_id: string;
  material_id: string;
  from_location_id: string;
  to_location_id: string;
  quantity: number | string;
  from_location_quantity: number | string;
  to_location_quantity: number | string;
  idempotent_replay: boolean;
};

export async function createTransfer(db: Db, input: TransferInput): Promise<StockResult<TransferResultDto>> {
  const { data, error } = await db.rpc("stock_transfer", {
    p_client_request_id: input.client_request_id,
    p_material_id: input.material_id,
    p_from_location_id: input.from_location_id,
    p_to_location_id: input.to_location_id,
    p_quantity: input.quantity,
    p_note: input.note ?? null,
  });
  if (error || !data) return { ok: false, error: mapStockError(error ?? {}, "createTransfer") };
  const r = data as TransferRpcResult;
  return {
    ok: true,
    data: {
      operationId: r.operation_id,
      materialId: r.material_id,
      fromLocationId: r.from_location_id,
      toLocationId: r.to_location_id,
      quantity: Number(r.quantity),
      fromLocationQuantity: Number(r.from_location_quantity),
      toLocationQuantity: Number(r.to_location_quantity),
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
// Lista ruchów (Przyjęcia, Wydania, Przesunięcia; historia w Etapie 6)
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
  reasonCode: string | null;
  productionOrderId: string | null;
  productionOrderName: string | null;
  /** Tylko przesunięcia: kody lokalizacji „skąd” i „dokąd”. */
  fromLocationCode: string | null;
  toLocationCode: string | null;
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
  reason_code?: string | null;
  production_order_id?: string | null;
  production_order_name?: string | null;
  from_location_code?: string | null;
  to_location_code?: string | null;
};

export type MovementPage = { items: MovementDto[]; total: number; page: number; pageSize: number };

/**
 * PRODUKCJA dostaje wyłącznie własne ruchy (wymusza funkcja DB). `since` — np. ostatnie 24 h na terminalu;
 * `collapseTransfers` — przesunięcie jako jeden wiersz (ruch przychodzący z kodami skąd/dokąd).
 */
export async function listMovements(
  db: Db,
  q: ListMovementsQuery,
  opts: { since?: string; collapseTransfers?: boolean } = {},
): Promise<ServiceResult<MovementPage>> {
  const { data, error } = await db.rpc("list_stock_movements", {
    p_type: q.type ?? null,
    p_material_q: q.q ?? null,
    p_date_from: q.from ?? null,
    p_date_to: q.to ?? null,
    p_page: q.page,
    p_page_size: q.pageSize,
    p_since: opts.since ?? null,
    p_production_order_id: q.orderId ?? null,
    p_collapse_transfers: opts.collapseTransfers ?? false,
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
        reasonCode: r.reason_code ?? null,
        productionOrderId: r.production_order_id ?? null,
        productionOrderName: r.production_order_name ?? null,
        fromLocationCode: r.from_location_code ?? null,
        toLocationCode: r.to_location_code ?? null,
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Moje ostatnie operacje (terminal) — przyjęcia, wydania, przesunięcia. RLS: PRODUKCJA widzi tylko własne;
// filtr user_id dla każdej roli (ADMIN na terminalu też widzi tylko swoje).
// ---------------------------------------------------------------------------
export type MyOperationDto = {
  operationId: string;
  type: OperationType;
  createdAt: string;
  quantity: number;
  materialCode: string;
  materialName: string;
  unit: string;
  /** Przyjęcie: dokąd; wydanie: skąd; przesunięcie: skąd. */
  locationCode: string;
  /** Tylko przesunięcie: dokąd. */
  toLocationCode: string | null;
  orderName: string | null;
  reasonCode: string | null;
};
type MyOperationRow = {
  id: string;
  type: OperationType;
  created_at: string;
  reason_code: string | null;
  order: { name: string } | null;
  movements: {
    quantity_delta: number | string;
    material: { code: string; name: string; unit: string } | null;
    location: { code: string } | null;
  }[];
};

export async function listMyRecentOperations(
  db: Db,
  userId: string,
  opts: { since: string; limit?: number },
): Promise<ServiceResult<MyOperationDto[]>> {
  const { data, error } = await db
    .from("stock_operations")
    .select(
      "id, type, created_at, reason_code, order:production_orders(name), " +
        "movements:stock_movements(quantity_delta, material:materials(code, name, unit), location:locations(code))",
    )
    .eq("user_id", userId)
    .in("type", ["RECEIPT", "ISSUE", "TRANSFER"])
    .gte("created_at", opts.since)
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 10);
  if (error) return { ok: false, error: mapStockError(error, "listMyRecentOperations") };
  const items: MyOperationDto[] = [];
  for (const r of data as unknown as MyOperationRow[]) {
    const out = r.movements.find((m) => Number(m.quantity_delta) < 0);
    const into = r.movements.find((m) => Number(m.quantity_delta) > 0);
    const main = r.type === "RECEIPT" ? into : out;
    if (!main) continue;
    items.push({
      operationId: r.id,
      type: r.type,
      createdAt: r.created_at,
      quantity: Math.abs(Number(main.quantity_delta)),
      materialCode: main.material?.code ?? "",
      materialName: main.material?.name ?? "",
      unit: main.material?.unit ?? "",
      locationCode: main.location?.code ?? "",
      toLocationCode: r.type === "TRANSFER" ? (into?.location?.code ?? null) : null,
      orderName: r.order?.name ?? null,
      reasonCode: r.reason_code,
    });
  }
  return { ok: true, data: items };
}

// ---------------------------------------------------------------------------
// Ostatnio używane materiały użytkownika (terminal: szybki wybór)
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
};

/**
 * Do `limit` różnych materiałów z ostatnich operacji użytkownika danego typu (najnowsze pierwsze).
 * Przyjęcie: tylko aktywne. Wydanie (`inStockOnly`): tylko materiały, które są teraz na stanie.
 */
export async function listRecentMaterials(
  db: Db,
  userId: string,
  opts: { type: "RECEIPT" | "ISSUE"; limit?: number; inStockOnly?: boolean },
): Promise<ServiceResult<RecentMaterialDto[]>> {
  const limit = opts.limit ?? 5;
  const { data, error } = await db
    .from("stock_movements")
    .select(
      "material:materials(id, code, name, unit, allows_fraction, active, default_supplier_id), operation:stock_operations!inner(type, user_id)",
    )
    .eq("user_id", userId)
    .eq("operation.type", opts.type)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return { ok: false, error: mapStockError(error, "listRecentMaterials") };
  const seen = new Set<string>();
  const candidates: RecentMaterialDto[] = [];
  for (const row of data as unknown as RecentRow[]) {
    const m = row.material;
    if (!m || seen.has(m.id) || (opts.type === "RECEIPT" && !m.active)) continue;
    seen.add(m.id);
    candidates.push({
      id: m.id,
      code: m.code,
      name: m.name,
      unit: m.unit,
      allowsFraction: m.allows_fraction,
      defaultSupplierId: m.default_supplier_id,
    });
  }
  if (!opts.inStockOnly || candidates.length === 0) return { ok: true, data: candidates.slice(0, limit) };

  const stock = await db
    .from("stock")
    .select("material_id")
    .in(
      "material_id",
      candidates.map((c) => c.id),
    )
    .gt("quantity", 0);
  if (stock.error) return { ok: false, error: mapStockError(stock.error, "listRecentMaterials stock") };
  const inStock = new Set((stock.data as { material_id: string }[]).map((r) => r.material_id));
  return { ok: true, data: candidates.filter((c) => inStock.has(c.id)).slice(0, limit) };
}

