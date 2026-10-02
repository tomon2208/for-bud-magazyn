import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fileTimestamp } from "@/lib/csv";
import { buildIlikeContainsValue } from "@/lib/validation/catalog";
import type { ExportStockQuery, ListTotalsQuery } from "@/lib/validation/stock";
import { mapStockError } from "./stock";
import type { ServiceResult } from "./users";

// Odczyty przeglądowe (Etap 7, ADR 012): sumy per materiał, poniżej minimum, statystyki dashboardu, eksport CSV.
// Wszystko liczy baza (widoki/funkcje SQL, klient UŻYTKOWNIKA → RLS); Worker tylko mapuje wyniki.
// Etap 11 (rezerwacje): stan DOSTĘPNY = suma stanu − aktywne rezerwacje — zmiana wyłącznie w widoku v_material_stock.

type Db = SupabaseClient;

// ---------------------------------------------------------------------------
// Suma per materiał
// ---------------------------------------------------------------------------
export type MaterialTotalDto = {
  materialId: string;
  code: string;
  name: string;
  unit: string;
  allowsFraction: boolean;
  active: boolean;
  categoryId: string;
  categoryName: string;
  defaultSupplierId: string | null;
  defaultSupplierName: string | null;
  minQuantity: number | null;
  totalQuantity: number;
  locationCount: number;
  belowMinimum: boolean;
  /** Ile brakuje do minimum (0, gdy nie ma minimum albo jest spełnione). */
  shortage: number;
};
type MaterialTotalRow = {
  material_id: string;
  material_code: string;
  material_name: string;
  unit: string;
  allows_fraction: boolean;
  material_active: boolean;
  category_id: string;
  category_name: string;
  default_supplier_id: string | null;
  default_supplier_name: string | null;
  min_quantity: number | string | null;
  total_quantity: number | string;
  location_count: number;
  below_minimum: boolean;
  shortage: number | string;
};
const TOTAL_COLUMNS =
  "material_id, material_code, material_name, unit, allows_fraction, material_active, category_id, category_name, " +
  "default_supplier_id, default_supplier_name, min_quantity, total_quantity, location_count, below_minimum, shortage";

const toTotal = (r: MaterialTotalRow): MaterialTotalDto => ({
  materialId: r.material_id,
  code: r.material_code,
  name: r.material_name,
  unit: r.unit,
  allowsFraction: r.allows_fraction,
  active: r.material_active,
  categoryId: r.category_id,
  categoryName: r.category_name,
  defaultSupplierId: r.default_supplier_id,
  defaultSupplierName: r.default_supplier_name,
  minQuantity: r.min_quantity === null ? null : Number(r.min_quantity),
  totalQuantity: Number(r.total_quantity),
  locationCount: Number(r.location_count),
  belowMinimum: r.below_minimum === true,
  shortage: Number(r.shortage),
});

export type MaterialTotalPage = { items: MaterialTotalDto[]; total: number; page: number; pageSize: number };

/**
 * Suma stanu per materiał. Domyślnie materiały ze stanem > 0 albo poniżej minimum (także stan 0);
 * `allActive` (mobilne SZUKAJ) — wszystkie aktywne materiały pasujące do frazy.
 */
export async function listMaterialTotals(db: Db, q: ListTotalsQuery): Promise<ServiceResult<MaterialTotalPage>> {
  let query = db
    .from("v_material_stock")
    .select(TOTAL_COLUMNS, { count: "exact" })
    .order("material_code", { ascending: true });
  if (q.allActive) query = query.eq("material_active", true);
  else query = query.eq("in_view", true);
  if (q.categoryId) query = query.eq("category_id", q.categoryId);
  if (q.belowMin) query = query.eq("below_minimum", true);
  if (q.q) {
    const pattern = buildIlikeContainsValue(q.q);
    query = query.or(`material_code.ilike.${pattern},material_name.ilike.${pattern}`);
  }
  const from = (q.page - 1) * q.pageSize;
  const { data, error, count } = await query.range(from, from + q.pageSize - 1);
  if (error) {
    if (error.code === "PGRST103") return { ok: true, data: { items: [], total: 0, page: q.page, pageSize: q.pageSize } };
    return { ok: false, error: mapStockError(error, "listMaterialTotals") };
  }
  return {
    ok: true,
    data: { items: (data as unknown as MaterialTotalRow[]).map(toTotal), total: count ?? 0, page: q.page, pageSize: q.pageSize },
  };
}

/** Jeden materiał z sumą stanu (ekran materiału). Brak materiału → ok z null. */
export async function getMaterialTotal(db: Db, materialId: string): Promise<ServiceResult<MaterialTotalDto | null>> {
  const { data, error } = await db.from("v_material_stock").select(TOTAL_COLUMNS).eq("material_id", materialId).maybeSingle();
  if (error) return { ok: false, error: mapStockError(error, "getMaterialTotal") };
  return { ok: true, data: data ? toTotal(data as unknown as MaterialTotalRow) : null };
}

/** Materiały poniżej minimum (aktywne), od największego braku. */
export async function listBelowMinimum(db: Db, limit = 50): Promise<ServiceResult<MaterialTotalDto[]>> {
  const { data, error } = await db
    .from("v_material_stock")
    .select(TOTAL_COLUMNS)
    .eq("below_minimum", true)
    .order("shortage", { ascending: false })
    .order("material_code", { ascending: true })
    .limit(limit);
  if (error) return { ok: false, error: mapStockError(error, "listBelowMinimum") };
  return { ok: true, data: (data as unknown as MaterialTotalRow[]).map(toTotal) };
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
export type DashboardStatsDto = {
  activeMaterials: number;
  activeLocations: number;
  materialsInStock: number;
  belowMinimum: number;
  /** Liczba operacji dzisiaj (doba Europe/Warsaw) wg typu: RECEIPT, ISSUE, TRANSFER, ADJUSTMENT, REVERSAL… */
  operationsToday: Record<string, number>;
};

export async function getDashboardStats(db: Db): Promise<ServiceResult<DashboardStatsDto>> {
  const { data, error } = await db.rpc("dashboard_stats");
  if (error || !data) return { ok: false, error: mapStockError(error ?? {}, "getDashboardStats") };
  const r = data as {
    active_materials: number;
    active_locations: number;
    materials_in_stock: number;
    below_minimum: number;
    operations_today: Record<string, number>;
  };
  return {
    ok: true,
    data: {
      activeMaterials: Number(r.active_materials),
      activeLocations: Number(r.active_locations),
      materialsInStock: Number(r.materials_in_stock),
      belowMinimum: Number(r.below_minimum),
      operationsToday: Object.fromEntries(Object.entries(r.operations_today ?? {}).map(([k, v]) => [k, Number(v)])),
    },
  };
}

// ---------------------------------------------------------------------------
// Eksport CSV — treść generuje baza (export_stock_csv); Worker tylko przekazuje string (budżet CPU).
// ---------------------------------------------------------------------------
export function stockCsvFilename(variant: ExportStockQuery["variant"], now: Date): string {
  const kind = variant === "location" ? "stany-lokalizacje" : "stany-materialy";
  return `${kind}_${fileTimestamp(now)}.csv`;
}

/** Treść CSV (bez BOM — dokleja route handler) i nazwa pliku. */
export async function exportStockCsv(
  db: Db,
  q: ExportStockQuery,
  now = new Date(),
): Promise<ServiceResult<{ filename: string; body: string }>> {
  const { data, error } = await db.rpc("export_stock_csv", {
    p_variant: q.variant,
    p_q: q.q ?? null,
    p_category_id: q.categoryId ?? null,
    p_below_min: q.belowMin ?? false,
  });
  if (error && error.code === "P0001" && error.hint === "TOO_MANY_ROWS") {
    return {
      ok: false,
      error: { status: 400, code: "TOO_MANY_ROWS", message: "Zbyt wiele wierszy do eksportu (maks. 20 000) — zawęź filtry" },
    };
  }
  if (error || typeof data !== "string") return { ok: false, error: mapStockError(error ?? {}, "exportStockCsv") };
  return { ok: true, data: { filename: stockCsvFilename(q.variant, now), body: data } };
}
