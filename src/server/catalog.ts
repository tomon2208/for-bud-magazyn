import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildIlikeContainsValue,
  likeContains,
  type CreateCategoryInput,
  type CreateMaterialInput,
  type CreateSupplierInput,
  type ListMaterialsQuery,
  type UpdateCategoryInput,
  type UpdateMaterialInput,
  type UpdateSupplierInput,
} from "@/lib/validation/catalog";
import type { ServiceError, ServiceResult } from "./users";

// Serwis kartotek. Wszystkie operacje idą przez klienta UŻYTKOWNIKA (RLS = druga linia obrony);
// autoryzację roli sprawdzają route handlery (requireApiRole).

type Db = SupabaseClient;
type DbError = { code?: string; message?: string; hint?: string | null };

const INTERNAL: ServiceError = {
  status: 500,
  code: "INTERNAL",
  message: "Wystąpił błąd serwera. Spróbuj ponownie.",
};

const NOT_FOUND = (message: string): ServiceError => ({ status: 404, code: "NOT_FOUND", message });

type Entity = "category" | "supplier" | "material";

const CONFLICTS: Record<Entity, ServiceError> = {
  category: { status: 409, code: "NAME_TAKEN", message: "Kategoria o tej nazwie już istnieje" },
  supplier: { status: 409, code: "NAME_TAKEN", message: "Dostawca o tej nazwie już istnieje" },
  material: { status: 409, code: "CODE_TAKEN", message: "Materiał o tym kodzie już istnieje" },
};

/** Mapowanie błędów PostgREST/PostgreSQL na błędy API (bez ujawniania szczegółów bazy). */
export function mapDbError(error: DbError, entity: Entity, context: string): ServiceError {
  if (error.code === "23505") return CONFLICTS[entity];
  if (error.code === "42501") return { status: 403, code: "FORBIDDEN", message: "Brak uprawnień" };
  if (error.code === "P0001" && error.hint === "INACTIVE_CATEGORY") {
    return { status: 400, code: "INACTIVE_CATEGORY", message: "Nie można wybrać nieaktywnej kategorii" };
  }
  if (error.code === "P0001" && error.hint === "INACTIVE_SUPPLIER") {
    return { status: 400, code: "INACTIVE_SUPPLIER", message: "Nie można wybrać nieaktywnego dostawcy" };
  }
  if (error.code === "P0001" && error.hint === "UNIT_LOCKED") {
    return {
      status: 409,
      code: "UNIT_LOCKED",
      message: "Nie można zmienić jednostki ani ułamkowości — materiał ma już ruchy magazynowe",
    };
  }
  if (error.code === "P0001" && error.hint === "MIN_NOT_INTEGER") {
    return {
      status: 400,
      code: "MIN_NOT_INTEGER",
      message: "Ten materiał liczy się w całych jednostkach — stan minimalny musi być liczbą całkowitą",
    };
  }
  if (error.code === "P0001" && error.hint === "HAS_STOCK") {
    return { status: 409, code: "HAS_STOCK", message: "Nie można dezaktywować materiału, który jest na stanie" };
  }
  if (error.code === "23503") {
    const supplier = error.message?.includes("default_supplier_id");
    return {
      status: 400,
      code: supplier ? "SUPPLIER_NOT_FOUND" : "CATEGORY_NOT_FOUND",
      message: supplier ? "Wskazany dostawca nie istnieje" : "Wskazana kategoria nie istnieje",
    };
  }
  if (error.code === "23514" || error.code === "22P02" || error.code === "23502") {
    return { status: 400, code: "VALIDATION", message: "Nieprawidłowe dane" };
  }
  console.error(context, error.code ?? "unknown");
  return INTERNAL;
}

// ---------------------------------------------------------------------------
// Kategorie
// ---------------------------------------------------------------------------
export type CategoryDto = { id: string; name: string; active: boolean; createdAt: string; updatedAt: string };
type CategoryRow = { id: string; name: string; active: boolean; created_at: string; updated_at: string };
const CATEGORY_COLUMNS = "id, name, active, created_at, updated_at";

const toCategory = (r: CategoryRow): CategoryDto => ({
  id: r.id,
  name: r.name,
  active: r.active,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export async function listCategories(
  db: Db,
  opts: { includeInactive: boolean },
): Promise<ServiceResult<CategoryDto[]>> {
  let query = db.from("material_categories").select(CATEGORY_COLUMNS).order("name", { ascending: true });
  if (!opts.includeInactive) query = query.eq("active", true);
  const { data, error } = await query;
  if (error) return { ok: false, error: mapDbError(error, "category", "listCategories") };
  return { ok: true, data: (data as CategoryRow[]).map(toCategory) };
}

export async function createCategory(db: Db, input: CreateCategoryInput): Promise<ServiceResult<CategoryDto>> {
  const { data, error } = await db.from("material_categories").insert(input).select(CATEGORY_COLUMNS).single();
  if (error || !data) return { ok: false, error: mapDbError(error ?? {}, "category", "createCategory") };
  return { ok: true, data: toCategory(data as CategoryRow) };
}

export async function updateCategory(
  db: Db,
  id: string,
  input: UpdateCategoryInput,
): Promise<ServiceResult<CategoryDto>> {
  const { data, error } = await db
    .from("material_categories")
    .update(input)
    .eq("id", id)
    .select(CATEGORY_COLUMNS)
    .maybeSingle();
  if (error) return { ok: false, error: mapDbError(error, "category", "updateCategory") };
  if (!data) return { ok: false, error: NOT_FOUND("Nie znaleziono kategorii") };
  return { ok: true, data: toCategory(data as CategoryRow) };
}

// ---------------------------------------------------------------------------
// Dostawcy
// ---------------------------------------------------------------------------
export type SupplierDto = {
  id: string;
  name: string;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};
type SupplierRow = {
  id: string;
  name: string;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
};
const SUPPLIER_COLUMNS = "id, name, contact_person, phone, email, notes, active, created_at, updated_at";

const toSupplier = (r: SupplierRow): SupplierDto => ({
  id: r.id,
  name: r.name,
  contactPerson: r.contact_person,
  phone: r.phone,
  email: r.email,
  notes: r.notes,
  active: r.active,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export async function listSuppliers(
  db: Db,
  opts: { q?: string; includeInactive: boolean },
): Promise<ServiceResult<SupplierDto[]>> {
  let query = db.from("suppliers").select(SUPPLIER_COLUMNS).order("name", { ascending: true }).limit(1000);
  if (!opts.includeInactive) query = query.eq("active", true);
  if (opts.q) query = query.ilike("name", likeContains(opts.q));
  const { data, error } = await query;
  if (error) return { ok: false, error: mapDbError(error, "supplier", "listSuppliers") };
  return { ok: true, data: (data as SupplierRow[]).map(toSupplier) };
}

export async function createSupplier(db: Db, input: CreateSupplierInput): Promise<ServiceResult<SupplierDto>> {
  const { data, error } = await db.from("suppliers").insert(input).select(SUPPLIER_COLUMNS).single();
  if (error || !data) return { ok: false, error: mapDbError(error ?? {}, "supplier", "createSupplier") };
  return { ok: true, data: toSupplier(data as SupplierRow) };
}

export async function updateSupplier(
  db: Db,
  id: string,
  input: UpdateSupplierInput,
): Promise<ServiceResult<SupplierDto>> {
  const { data, error } = await db
    .from("suppliers")
    .update(input)
    .eq("id", id)
    .select(SUPPLIER_COLUMNS)
    .maybeSingle();
  if (error) return { ok: false, error: mapDbError(error, "supplier", "updateSupplier") };
  if (!data) return { ok: false, error: NOT_FOUND("Nie znaleziono dostawcy") };
  return { ok: true, data: toSupplier(data as SupplierRow) };
}

// ---------------------------------------------------------------------------
// Materiały
// ---------------------------------------------------------------------------
export type MaterialDto = {
  id: string;
  code: string;
  name: string;
  categoryId: string;
  categoryName: string;
  unit: string;
  allowsFraction: boolean;
  defaultSupplierId: string | null;
  defaultSupplierName: string | null;
  /** Stan minimalny; null = brak alarmu. */
  minQuantity: number | null;
  active: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};
type MaterialRow = {
  id: string;
  code: string;
  name: string;
  category_id: string;
  unit: string;
  allows_fraction: boolean;
  default_supplier_id: string | null;
  min_quantity: number | string | null;
  active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
  category: { name: string } | null;
  supplier: { name: string } | null;
};
const MATERIAL_COLUMNS =
  "id, code, name, category_id, unit, allows_fraction, default_supplier_id, min_quantity, active, notes, created_at, updated_at, " +
  "category:material_categories(name), supplier:suppliers(name)";

const toMaterial = (r: MaterialRow): MaterialDto => ({
  id: r.id,
  code: r.code,
  name: r.name,
  categoryId: r.category_id,
  categoryName: r.category?.name ?? "",
  unit: r.unit,
  allowsFraction: r.allows_fraction,
  defaultSupplierId: r.default_supplier_id,
  defaultSupplierName: r.supplier?.name ?? null,
  minQuantity: r.min_quantity === null ? null : Number(r.min_quantity),
  active: r.active,
  notes: r.notes,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export type MaterialPage = { items: MaterialDto[]; total: number; page: number; pageSize: number };

export async function listMaterials(db: Db, q: ListMaterialsQuery): Promise<ServiceResult<MaterialPage>> {
  // inStock: złączenie z wierszami stanu > 0 (!inner — materiał bez takiego wiersza odpada).
  let query = db
    .from("materials")
    .select(q.inStock ? `${MATERIAL_COLUMNS}, stock!inner(quantity)` : MATERIAL_COLUMNS, { count: "exact" })
    .order("code", { ascending: true });
  if (q.inStock) query = query.gt("stock.quantity", 0);
  if (!q.includeInactive) query = query.eq("active", true);
  if (q.categoryId) query = query.eq("category_id", q.categoryId);
  if (q.q) {
    const pattern = buildIlikeContainsValue(q.q);
    query = query.or(`code.ilike.${pattern},name.ilike.${pattern}`);
  }
  const from = (q.page - 1) * q.pageSize;
  const { data, error, count } = await query.range(from, from + q.pageSize - 1);
  if (error) {
    // Strona poza zakresem → PostgREST zwraca 416 (PGRST103): pusta strona zamiast błędu.
    if (error.code === "PGRST103") {
      // Prawdziwe total (te same filtry), żeby UI mogło przejść na ostatnią stronę.
      let countQuery = db
        .from("materials")
        .select(q.inStock ? "id, stock!inner(quantity)" : "id", { count: "exact", head: true });
      if (q.inStock) countQuery = countQuery.gt("stock.quantity", 0);
      if (!q.includeInactive) countQuery = countQuery.eq("active", true);
      if (q.categoryId) countQuery = countQuery.eq("category_id", q.categoryId);
      if (q.q) {
        const pattern = buildIlikeContainsValue(q.q);
        countQuery = countQuery.or(`code.ilike.${pattern},name.ilike.${pattern}`);
      }
      const { count: total, error: countError } = await countQuery;
      if (countError) return { ok: false, error: mapDbError(countError, "material", "listMaterials count") };
      return { ok: true, data: { items: [], total: total ?? 0, page: q.page, pageSize: q.pageSize } };
    }
    return { ok: false, error: mapDbError(error, "material", "listMaterials") };
  }
  return {
    ok: true,
    data: {
      items: (data as unknown as MaterialRow[]).map(toMaterial),
      total: count ?? 0,
      page: q.page,
      pageSize: q.pageSize,
    },
  };
}

export async function getMaterial(db: Db, id: string): Promise<ServiceResult<MaterialDto>> {
  const { data, error } = await db.from("materials").select(MATERIAL_COLUMNS).eq("id", id).maybeSingle();
  if (error) return { ok: false, error: mapDbError(error, "material", "getMaterial") };
  if (!data) return { ok: false, error: NOT_FOUND("Nie znaleziono materiału") };
  return { ok: true, data: toMaterial(data as unknown as MaterialRow) };
}

export async function createMaterial(db: Db, input: CreateMaterialInput): Promise<ServiceResult<MaterialDto>> {
  const { data, error } = await db.from("materials").insert(input).select(MATERIAL_COLUMNS).single();
  if (error || !data) return { ok: false, error: mapDbError(error ?? {}, "material", "createMaterial") };
  return { ok: true, data: toMaterial(data as unknown as MaterialRow) };
}

export async function updateMaterial(
  db: Db,
  id: string,
  input: UpdateMaterialInput,
): Promise<ServiceResult<MaterialDto>> {
  const { data, error } = await db
    .from("materials")
    .update(input)
    .eq("id", id)
    .select(MATERIAL_COLUMNS)
    .maybeSingle();
  if (error) return { ok: false, error: mapDbError(error, "material", "updateMaterial") };
  if (!data) return { ok: false, error: NOT_FOUND("Nie znaleziono materiału") };
  return { ok: true, data: toMaterial(data as unknown as MaterialRow) };
}
