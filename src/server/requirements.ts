import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fileTimestamp } from "@/lib/csv";
import { parseSubstitutes, type SubstituteOption } from "@/lib/substitutes";
import type {
  CreateRequirementInput,
  ShortagesQuery,
  SubstituteRequirementInput,
  WithdrawRequirementInput,
} from "@/lib/validation/requirements";
import type { ServiceError, ServiceResult } from "./users";

// Zapotrzebowanie zlecenia (listy niezmienne, sumowane) i braki (Etap 8–10, ADR 013).
// Zapis: funkcje DB create_requirement / withdraw_requirement (BIURO, ADMIN; klient UŻYTKOWNIKA). Braki liczy baza
// (funkcje SQL) — Worker tylko mapuje wyniki (budżet CPU).

type Db = SupabaseClient;
type DbError = { code?: string; message?: string; hint?: string | null; details?: string | null };

const INTERNAL: ServiceError = { status: 500, code: "INTERNAL", message: "Wystąpił błąd serwera. Spróbuj ponownie." };

const NOT_FOUND_MESSAGES: Record<string, string> = {
  order: "Nie znaleziono zlecenia",
  material: "Nie znaleziono materiału",
  requirement: "Nie znaleziono listy zapotrzebowania",
  alias: "Nie znaleziono powiązania",
};

/** Błąd z funkcji zapotrzebowania/braków → błąd API (bez ujawniania szczegółów bazy). `details` = kod materiału itp. */
export function mapRequirementError(error: DbError, context: string): ServiceError & { material?: string } {
  if (error.code === "42501") return { status: 403, code: "FORBIDDEN", message: "Brak uprawnień" };
  if (error.code === "P0001" && error.hint) {
    const material = error.details ?? undefined;
    switch (error.hint) {
      case "NOT_FOUND":
        return { status: 404, code: "NOT_FOUND", message: NOT_FOUND_MESSAGES[error.details ?? ""] ?? "Nie znaleziono" };
      case "ORDER_NOT_OPEN":
        return {
          status: 409,
          code: "ORDER_NOT_OPEN",
          message: "Zlecenie jest zakończone lub anulowane — otwórz je ponownie, aby dodać listę",
        };
      case "ALREADY_WITHDRAWN":
        return { status: 409, code: "ALREADY_WITHDRAWN", message: "Ta lista została już wycofana" };
      case "IDEMPOTENCY_CONFLICT":
        return { status: 409, code: "IDEMPOTENCY_CONFLICT", message: "Ten identyfikator żądania został już użyty. Odśwież ekran." };
      case "DUPLICATE_MATERIAL":
        return { status: 400, code: "DUPLICATE_MATERIAL", message: "Ten sam materiał występuje na liście więcej niż raz" };
      case "INVALID_QUANTITY":
        return {
          status: 400,
          code: "INVALID_QUANTITY",
          message: "Ilość musi być większa od zera, maksymalnie 1 000 000, do 3 miejsc po przecinku",
        };
      case "NOT_INTEGER":
        return {
          status: 400,
          code: "NOT_INTEGER",
          message: `Materiał${material ? ` ${material}` : ""} liczy się w całych jednostkach (bez ułamków)`,
          material,
        };
      case "MATERIAL_INACTIVE":
        return { status: 400, code: "MATERIAL_INACTIVE", message: `Materiał${material ? ` ${material}` : ""} jest nieaktywny`, material };
      case "NUMBER_TAKEN":
        return { status: 409, code: "NUMBER_TAKEN", message: "Zlecenie o tym numerze już istnieje" };
      case "INVALID_CODE":
        return { status: 400, code: "INVALID_CODE", message: "Kod zawiera niedozwolone znaki (dozwolone: A–Z, cyfry, . _ / - i pojedyncze spacje) albo jest za długi" };
      case "TOO_MANY_ROWS":
        return { status: 400, code: "TOO_MANY_ROWS", message: "Zbyt wiele wierszy do eksportu (maks. 20 000) — zawęź filtry" };
      case "NOT_A_SUBSTITUTE":
        return { status: 400, code: "NOT_A_SUBSTITUTE", message: "Wybrane materiały nie są odpowiednikami" };
      case "NOT_IN_REQUIREMENTS":
        return {
          status: 400,
          code: "NOT_IN_REQUIREMENTS",
          message: `Materiał${material ? ` ${material}` : ""} nie występuje na tej liście zapotrzebowania`,
          material,
        };
      case "NOTHING_TO_SUBSTITUTE":
        return { status: 409, code: "NOTHING_TO_SUBSTITUTE", message: "Ta pozycja jest już w całości wydana — nie ma czego podmieniać" };
      case "VALIDATION":
        return { status: 400, code: "VALIDATION", message: "Nieprawidłowe dane" };
    }
  }
  if (error.code === "22P02" || error.code === "23514" || error.code === "22003") {
    return { status: 400, code: "VALIDATION", message: "Nieprawidłowe dane" };
  }
  if (error.code === "23505") {
    return { status: 409, code: "RETRY", message: "Operacja jest w toku. Spróbuj ponownie za chwilę." };
  }
  console.error(context, error.code ?? "unknown");
  return INTERNAL;
}

// ---------------------------------------------------------------------------
// Listy zapotrzebowania
// ---------------------------------------------------------------------------
export type RequirementItemDto = {
  id: string;
  materialId: string;
  materialCode: string;
  materialName: string;
  unit: string;
  allowsFraction: boolean;
  quantity: number;
  note: string | null;
};
export type RequirementDto = {
  id: string;
  name: string;
  source: "MANUAL" | "IMPORT";
  status: "ACTIVE" | "WITHDRAWN";
  importedFileName: string | null;
  importFormat: string | null;
  withdrawnAt: string | null;
  withdrawReason: string | null;
  createdAt: string;
  items: RequirementItemDto[];
};
type RequirementRow = {
  id: string;
  name: string;
  source: "MANUAL" | "IMPORT";
  status: "ACTIVE" | "WITHDRAWN";
  imported_file_name: string | null;
  import_format: string | null;
  withdrawn_at: string | null;
  withdraw_reason: string | null;
  created_at: string;
  items: {
    id: string;
    material_id: string;
    quantity: number | string;
    note: string | null;
    material: { code: string; name: string; unit: string; allows_fraction: boolean } | null;
  }[];
};

const REQUIREMENT_SELECT =
  "id, name, source, status, imported_file_name, import_format, withdrawn_at, withdraw_reason, created_at, " +
  "items:requirement_items(id, material_id, quantity, note, material:materials(code, name, unit, allows_fraction))";

/** Listy zapotrzebowania zlecenia (od najstarszej) z pozycjami posortowanymi po kodzie materiału. */
export async function listRequirements(db: Db, orderId: string): Promise<ServiceResult<RequirementDto[]>> {
  const { data, error } = await db
    .from("requirements")
    .select(REQUIREMENT_SELECT)
    .eq("production_order_id", orderId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) return { ok: false, error: mapRequirementError(error, "listRequirements") };
  return {
    ok: true,
    data: (data as unknown as RequirementRow[]).map((r) => ({
      id: r.id,
      name: r.name,
      source: r.source,
      status: r.status,
      importedFileName: r.imported_file_name,
      importFormat: r.import_format,
      withdrawnAt: r.withdrawn_at,
      withdrawReason: r.withdraw_reason,
      createdAt: r.created_at,
      items: r.items
        .map((i) => ({
          id: i.id,
          materialId: i.material_id,
          materialCode: i.material?.code ?? "?",
          materialName: i.material?.name ?? "",
          unit: i.material?.unit ?? "",
          allowsFraction: i.material?.allows_fraction ?? true,
          quantity: Number(i.quantity),
          note: i.note,
        }))
        .sort((a, b) => a.materialCode.localeCompare(b.materialCode, "pl")),
    })),
  };
}

export type CreatedRequirementDto = { requirementId: string; itemCount: number; idempotentReplay: boolean };

/** Nowa lista zapotrzebowania (jedna transakcja w bazie). BIURO, ADMIN. */
export async function createRequirement(
  db: Db,
  orderId: string,
  input: CreateRequirementInput,
): Promise<ServiceResult<CreatedRequirementDto>> {
  const { data, error } = await db.rpc("create_requirement", {
    p_order_id: orderId,
    p_name: input.name,
    p_items: input.items.map((i) => ({ material_id: i.material_id, quantity: i.quantity, note: i.note ?? null })),
    p_client_request_id: input.client_request_id ?? null,
  });
  if (error || !data) return { ok: false, error: mapRequirementError(error ?? {}, "createRequirement") };
  const r = data as { requirement_id: string; item_count: number; idempotent_replay: boolean };
  return { ok: true, data: { requirementId: r.requirement_id, itemCount: Number(r.item_count), idempotentReplay: r.idempotent_replay === true } };
}

/** Wycofanie listy z powodem (lista nie liczy się do zapotrzebowania). BIURO, ADMIN. */
export async function withdrawRequirement(
  db: Db,
  requirementId: string,
  input: WithdrawRequirementInput,
): Promise<ServiceResult<{ requirementId: string }>> {
  const { error } = await db.rpc("withdraw_requirement", { p_requirement_id: requirementId, p_reason: input.reason });
  if (error) return { ok: false, error: mapRequirementError(error, "withdrawRequirement") };
  return { ok: true, data: { requirementId } };
}

export type SubstitutedRequirementDto = {
  requirementId: string;
  orderId: string;
  withdrawnRequirementId: string;
  /** Ilość przeniesiona na odpowiednik (null przy powtórzeniu żądania). */
  movedQuantity: number | null;
  /** Część oryginału już wydana — zostaje na kopii listy jako oryginał. */
  keptQuantity: number | null;
  idempotentReplay: boolean;
};

/**
 * „Podmień” (Etap 12b): pozycja listy → odpowiednik. Atomowo w bazie: wycofanie listy + poprawiona kopia. BIURO, ADMIN.
 */
export async function substituteRequirementItem(
  db: Db,
  requirementId: string,
  input: SubstituteRequirementInput,
): Promise<ServiceResult<SubstitutedRequirementDto>> {
  const { data, error } = await db.rpc("substitute_requirement_item", {
    p_client_request_id: input.client_request_id,
    p_requirement_id: requirementId,
    p_from_material: input.from_material_id,
    p_to_material: input.to_material_id,
    p_reason: input.reason ?? null,
  });
  if (error || !data) return { ok: false, error: mapRequirementError(error ?? {}, "substituteRequirementItem") };
  const r = data as {
    requirement_id: string;
    order_id: string;
    withdrawn_requirement_id: string;
    moved_quantity?: number | string;
    kept_quantity?: number | string;
    idempotent_replay: boolean;
  };
  return {
    ok: true,
    data: {
      requirementId: r.requirement_id,
      orderId: r.order_id,
      withdrawnRequirementId: r.withdrawn_requirement_id,
      movedQuantity: r.moved_quantity === undefined ? null : Number(r.moved_quantity),
      keptQuantity: r.kept_quantity === undefined ? null : Number(r.kept_quantity),
      idempotentReplay: r.idempotent_replay === true,
    },
  };
}

// ---------------------------------------------------------------------------
// Braki
// ---------------------------------------------------------------------------
export type OrderShortageDto = {
  materialId: string;
  materialCode: string;
  materialName: string;
  unit: string;
  needed: number;
  issued: number;
  remaining: number;
  /** Dostępne DLA TEGO ZLECENIA = wolne (stan w aktywnych lokalizacjach − wszystkie rezerwacje) + rezerwacja zlecenia. */
  available: number;
  shortage: number;
  /** Zarezerwowane dla tego zlecenia. */
  reserved: number;
  /** Wolne w magazynie (wspólne dla wszystkich zleceń). */
  free: number;
  /** Etap 12b: aktywne odpowiedniki; available = wolne + rezerwacja TEGO zlecenia na odpowiednik. */
  substitutes: SubstituteOption[];
};
type OrderShortageRow = {
  material_id: string;
  material_code: string;
  material_name: string;
  unit: string;
  needed: number | string;
  issued: number | string;
  remaining: number | string;
  available: number | string;
  shortage: number | string;
  reserved: number | string;
  free: number | string;
  substitutes?: unknown;
};

/** Braki jednego zlecenia (ADMIN, BIURO). */
export async function getOrderShortages(db: Db, orderId: string): Promise<ServiceResult<OrderShortageDto[]>> {
  const { data, error } = await db.rpc("order_shortages", { p_order_id: orderId });
  if (error) return { ok: false, error: mapRequirementError(error, "getOrderShortages") };
  return {
    ok: true,
    data: ((data ?? []) as OrderShortageRow[]).map((r) => ({
      materialId: r.material_id,
      materialCode: r.material_code,
      materialName: r.material_name,
      unit: r.unit,
      needed: Number(r.needed),
      issued: Number(r.issued),
      remaining: Number(r.remaining),
      available: Number(r.available),
      shortage: Number(r.shortage),
      reserved: Number(r.reserved),
      free: Number(r.free),
      substitutes: parseSubstitutes(r.substitutes),
    })),
  };
}

export type ShortageOrderRef = { orderId: string; number: string | null; name: string; remaining: number };
export type ShortageDto = {
  materialId: string;
  materialCode: string;
  materialName: string;
  unit: string;
  categoryId: string;
  categoryName: string;
  supplierId: string | null;
  supplierName: string | null;
  /** Suma „pozostało do wydania” po zleceniach Otwarte + W produkcji. */
  remaining: number;
  /** Stan łączny (aktywne lokalizacje) — liczony raz na materiał. */
  available: number;
  shortage: number;
  orders: ShortageOrderRef[];
  /** Etap 12b: aktywne odpowiedniki z wolnym stanem (bez rezerwacji zleceń — wolne wspólne). */
  substitutes: SubstituteOption[];
};
type ShortageRow = {
  material_id: string;
  material_code: string;
  material_name: string;
  unit: string;
  category_id: string;
  category_name: string;
  supplier_id: string | null;
  supplier_name: string | null;
  remaining: number | string;
  available: number | string;
  shortage: number | string;
  orders: { order_id: string; number: string | null; name: string; remaining: number | string }[];
  total_rows: number | string;
  substitutes?: unknown;
};

/** Braki zbiorczo per materiał (ADMIN, BIURO): dostawca → największy brak. `total` > items.length = obcięte (limit 2000). */
export async function listShortages(db: Db, q: ShortagesQuery): Promise<ServiceResult<{ items: ShortageDto[]; total: number }>> {
  const { data, error } = await db.rpc("shortages_summary", {
    p_supplier_id: q.supplier ?? null,
    p_category_id: q.category ?? null,
    p_only_short: q.onlyShort ?? false,
  });
  if (error) return { ok: false, error: mapRequirementError(error, "listShortages") };
  const rows = (data ?? []) as ShortageRow[];
  return {
    ok: true,
    data: {
      total: rows.length > 0 ? Number(rows[0].total_rows) : 0,
      items: rows.map((r) => ({
        materialId: r.material_id,
        materialCode: r.material_code,
        materialName: r.material_name,
        unit: r.unit,
        categoryId: r.category_id,
        categoryName: r.category_name,
        supplierId: r.supplier_id,
        supplierName: r.supplier_name,
        remaining: Number(r.remaining),
        available: Number(r.available),
        shortage: Number(r.shortage),
        orders: (r.orders ?? []).map((o) => ({ orderId: o.order_id, number: o.number, name: o.name, remaining: Number(o.remaining) })),
        substitutes: parseSubstitutes(r.substitutes),
      })),
    },
  };
}

/** Liczba materiałów z brakiem do zleceń (kafel dashboardu). */
export async function getShortageCount(db: Db): Promise<ServiceResult<number>> {
  const { data, error } = await db.rpc("shortage_material_count");
  if (error) return { ok: false, error: mapRequirementError(error, "getShortageCount") };
  return { ok: true, data: Number(data ?? 0) };
}

export function shortagesCsvFilename(now: Date): string {
  return `braki_${fileTimestamp(now)}.csv`;
}

/** Treść CSV braków (bez BOM — dokleja route handler) i nazwa pliku; CSV buduje baza. */
export async function exportShortagesCsv(
  db: Db,
  q: ShortagesQuery,
  now = new Date(),
): Promise<ServiceResult<{ filename: string; body: string }>> {
  const { data, error } = await db.rpc("export_shortages_csv", {
    p_supplier_id: q.supplier ?? null,
    p_category_id: q.category ?? null,
    p_only_short: q.onlyShort ?? false,
  });
  if (error || typeof data !== "string") return { ok: false, error: mapRequirementError(error ?? {}, "exportShortagesCsv") };
  return { ok: true, data: { filename: shortagesCsvFilename(now), body: data } };
}

// ---------------------------------------------------------------------------
// Terminal: „Do wydania na to zlecenie”
// ---------------------------------------------------------------------------
export type ToIssueDto = {
  materialId: string;
  materialCode: string;
  materialName: string;
  unit: string;
  allowsFraction: boolean;
  remaining: number;
  /** Dostępne dla tego zlecenia (wolne + jego rezerwacja), łącznie we wszystkich aktywnych lokalizacjach. */
  available: number;
  /** Rezerwacja tego zlecenia (część „available”). */
  reserved: number;
  /** Etap 12b: aktywne odpowiedniki; available = wolne + rezerwacja tego zlecenia na odpowiednik. */
  substitutes: SubstituteOption[];
};
type ToIssueRow = {
  material_id: string;
  material_code: string;
  material_name: string;
  unit: string;
  allows_fraction: boolean;
  remaining: number | string;
  available: number | string;
  reserved: number | string;
  substitutes?: unknown;
};

/** Pozycje zlecenia z „pozostało do wydania” > 0 (każda rola z dostępem do magazynu). */
export async function getOrderToIssue(db: Db, orderId: string): Promise<ServiceResult<ToIssueDto[]>> {
  const { data, error } = await db.rpc("order_to_issue", { p_order_id: orderId });
  if (error) return { ok: false, error: mapRequirementError(error, "getOrderToIssue") };
  return {
    ok: true,
    data: ((data ?? []) as ToIssueRow[]).map((r) => ({
      materialId: r.material_id,
      materialCode: r.material_code,
      materialName: r.material_name,
      unit: r.unit,
      allowsFraction: r.allows_fraction,
      remaining: Number(r.remaining),
      available: Number(r.available),
      reserved: Number(r.reserved ?? 0),
      substitutes: parseSubstitutes(r.substitutes),
    })),
  };
}
