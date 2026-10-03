import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fileTimestamp } from "@/lib/csv";
import type {
  ApproveInput,
  CancelSessionInput,
  CloseSessionInput,
  CreateSessionInput,
  ReviewStatus,
  SaveCountInput,
  SessionStatus,
} from "@/lib/validation/inventory";
import type { ServiceError } from "./users";

// Inwentaryzacja (Etap 13, ADR 015). Zapis: funkcje DB inventory_* (klient UŻYTKOWNIKA — auth.uid() = autor).
// Odczyty liczy baza; wariant dla liczącego (inventory_counting_location, overview) nie zawiera stanów systemowych.

type Db = SupabaseClient;
type DbError = { code?: string; message?: string; hint?: string | null; details?: string | null };
export type InventoryError = ServiceError & { details?: Record<string, unknown> };
export type InventoryResult<T> = { ok: true; data: T } | { ok: false; error: InventoryError };

const INTERNAL: ServiceError = { status: 500, code: "INTERNAL", message: "Wystąpił błąd serwera. Spróbuj ponownie." };
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : num(v));

const NOT_FOUND_MESSAGES: Record<string, string> = {
  session: "Nie znaleziono sesji inwentaryzacji",
  location: "Nie znaleziono lokalizacji",
  material: "Nie znaleziono materiału",
  count: "Nie znaleziono pozycji liczenia w tej sesji",
};

export function mapInventoryError(error: DbError, context: string): InventoryError {
  if (error.code === "42501") return { status: 403, code: "FORBIDDEN", message: "Brak uprawnień" };
  if (error.code === "P0001" && error.hint) {
    switch (error.hint) {
      case "NOT_FOUND":
        return { status: 404, code: "NOT_FOUND", message: NOT_FOUND_MESSAGES[error.details ?? ""] ?? "Nie znaleziono" };
      case "SESSION_NOT_OPEN":
        return { status: 409, code: "SESSION_NOT_OPEN", message: "Sesja inwentaryzacji jest już zamknięta lub anulowana" };
      case "SESSION_HAS_APPROVALS":
        return { status: 409, code: "SESSION_HAS_APPROVALS", message: "Sesja ma zatwierdzone pozycje — zamknij ją zamiast anulować" };
      case "LOCATION_IN_OPEN_SESSION":
        return {
          status: 409,
          code: "LOCATION_IN_OPEN_SESSION",
          message: `Lokalizacje są już w otwartej sesji: ${error.details ?? ""}`,
          details: { locations: error.details ?? "" },
        };
      case "LOCATION_INACTIVE":
        return { status: 400, code: "LOCATION_INACTIVE", message: `Lokalizacje nieaktywne: ${error.details ?? ""}` };
      case "NO_LOCATIONS":
        return { status: 400, code: "NO_LOCATIONS", message: "Brak aktywnych lokalizacji pasujących do wyboru" };
      case "LOCATION_NOT_IN_SESSION":
        return { status: 409, code: "LOCATION_NOT_IN_SESSION", message: "Ta lokalizacja nie należy do wybranej sesji inwentaryzacji" };
      case "ALREADY_APPROVED":
        return {
          status: 409,
          code: "ALREADY_APPROVED",
          message: `Pozycja ${error.details ?? ""} jest już zatwierdzona — nie można zmienić liczenia`,
          details: { materialCode: error.details ?? "" },
        };
      case "LOCATION_COUNT_CHANGED":
        return {
          status: 409,
          code: "LOCATION_COUNT_CHANGED",
          message: "Ktoś zapisał tę lokalizację w międzyczasie — otwórz ją ponownie i sprawdź liczenie",
        };
      case "COUNT_STALE":
        return { status: 409, code: "COUNT_STALE", message: "Liczenie trwało zbyt długo — otwórz lokalizację ponownie i policz jeszcze raz" };
      case "IDEMPOTENCY_CONFLICT":
        return { status: 409, code: "IDEMPOTENCY_CONFLICT", message: "Ten identyfikator żądania został już użyty. Odśwież ekran." };
      case "DUPLICATE_MATERIAL":
        return { status: 400, code: "DUPLICATE_MATERIAL", message: "Ten sam materiał występuje więcej niż raz" };
      case "NOT_INTEGER":
        return {
          status: 400,
          code: "NOT_INTEGER",
          message: `Materiał ${error.details ?? ""} liczy się w całych jednostkach`,
          details: { materialCode: error.details ?? "" },
        };
      case "INVALID_QUANTITY":
        return { status: 400, code: "INVALID_QUANTITY", message: "Ilość: od 0 do 1 000 000, do 3 miejsc po przecinku" };
      case "VALIDATION":
        return { status: 400, code: "VALIDATION", message: error.message ?? "Nieprawidłowe dane" };
    }
  }
  if (error.code === "22P02" || error.code === "23514") return { status: 400, code: "VALIDATION", message: "Nieprawidłowe dane" };
  if (error.code === "23505") {
    if ((error.message ?? "").includes("inventory_session_locations_one_open")) {
      return { status: 409, code: "LOCATION_IN_OPEN_SESSION", message: "Część lokalizacji jest już w innej otwartej sesji" };
    }
    return { status: 409, code: "RETRY", message: "Operacja jest w toku. Spróbuj ponownie za chwilę." };
  }
  if (error.code === "22003") return { status: 400, code: "STOCK_LIMIT", message: "Przekroczono maksymalny stan" };
  console.error(context, error.code ?? "unknown");
  return INTERNAL;
}

// ---------------------------------------------------------------------------
// Zapis
// ---------------------------------------------------------------------------
export type CreateSessionResultDto = { sessionId: string; name: string; locationCount: number; idempotentReplay: boolean };

export async function createInventorySession(db: Db, input: CreateSessionInput): Promise<InventoryResult<CreateSessionResultDto>> {
  const { data, error } = await db.rpc("inventory_create_session", {
    p_client_request_id: input.client_request_id,
    p_name: input.name,
    p_note: input.note ?? null,
    p_location_ids: input.location_ids ?? null,
    p_code_prefix: input.code_prefix ?? null,
    p_all_locations: input.all_locations === true,
  });
  if (error || !data) return { ok: false, error: mapInventoryError(error ?? {}, "createInventorySession") };
  const r = data as { session_id: string; name: string; location_count: unknown; idempotent_replay: boolean };
  return {
    ok: true,
    data: { sessionId: r.session_id, name: r.name, locationCount: num(r.location_count), idempotentReplay: r.idempotent_replay === true },
  };
}

export type SaveCountResultDto = {
  sessionId: string;
  locationId: string;
  saved: number;
  removed: number;
  /** Pozycje bez zmian (zatwierdzone albo ta sama ilość bez ruchu od liczenia). */
  unchanged: number;
  locationVersion: number;
  idempotentReplay: boolean;
};

export async function saveLocationCount(
  db: Db,
  sessionId: string,
  locationId: string,
  input: SaveCountInput,
): Promise<InventoryResult<SaveCountResultDto>> {
  const { data, error } = await db.rpc("inventory_save_location_count", {
    p_client_request_id: input.client_request_id,
    p_session_id: sessionId,
    p_location_id: locationId,
    p_items: input.items.map((i) => ({ material_id: i.material_id, quantity: i.quantity })),
    p_started_at: input.started_at,
    p_expected_version: input.location_version,
  });
  if (error || !data) return { ok: false, error: mapInventoryError(error ?? {}, "saveLocationCount") };
  const r = data as Record<string, unknown>;
  return {
    ok: true,
    data: {
      sessionId: String(r.session_id),
      locationId: String(r.location_id),
      saved: num(r.saved),
      removed: num(r.removed),
      unchanged: num(r.unchanged),
      locationVersion: num(r.location_version),
      idempotentReplay: r.idempotent_replay === true,
    },
  };
}

export type ApproveResultDto = {
  sessionId: string;
  operationId: string | null;
  approved: { countId: string; materialCode: string; locationCode: string; quantityDelta: number; newQuantity: number }[];
  approvedCount: number;
  matchedCount: number;
  recount: { countId: string; materialCode: string; locationCode: string }[];
  skipped: { countId: string; materialCode: string; locationCode: string; reason: string }[];
  idempotentReplay: boolean;
};

type ApproveRow = { count_id: string; material_code: string; location_code: string; quantity_delta?: unknown; new_quantity?: unknown; reason?: string };

export async function approveInventory(db: Db, sessionId: string, input: ApproveInput): Promise<InventoryResult<ApproveResultDto>> {
  const { data, error } = await db.rpc("inventory_approve", {
    p_client_request_id: input.client_request_id,
    p_session_id: sessionId,
    p_count_ids: input.count_ids && input.count_ids.length > 0 ? input.count_ids : null,
    p_expected_counts: input.expected_counts ?? null,
  });
  if (error || !data) return { ok: false, error: mapInventoryError(error ?? {}, "approveInventory") };
  const r = data as {
    session_id: string;
    operation_id: string | null;
    approved: ApproveRow[];
    approved_count: unknown;
    matched_count: unknown;
    recount: ApproveRow[];
    skipped: ApproveRow[];
    idempotent_replay: boolean;
  };
  return {
    ok: true,
    data: {
      sessionId: r.session_id,
      operationId: r.operation_id ?? null,
      approved: (r.approved ?? []).map((x) => ({
        countId: x.count_id,
        materialCode: x.material_code,
        locationCode: x.location_code,
        quantityDelta: num(x.quantity_delta),
        newQuantity: num(x.new_quantity),
      })),
      approvedCount: num(r.approved_count),
      matchedCount: num(r.matched_count),
      recount: (r.recount ?? []).map((x) => ({ countId: x.count_id, materialCode: x.material_code, locationCode: x.location_code })),
      skipped: (r.skipped ?? []).map((x) => ({
        countId: x.count_id,
        materialCode: x.material_code,
        locationCode: x.location_code,
        reason: x.reason ?? "",
      })),
      idempotentReplay: r.idempotent_replay === true,
    },
  };
}

export type CloseResultDto = {
  sessionId: string;
  status: SessionStatus;
  uncountedLocations: number;
  unapprovedCounts: number;
  idempotentReplay: boolean;
};

export async function closeInventorySession(db: Db, sessionId: string, input: CloseSessionInput): Promise<InventoryResult<CloseResultDto>> {
  const { data, error } = await db.rpc("inventory_close_session", {
    p_client_request_id: input.client_request_id,
    p_session_id: sessionId,
  });
  if (error || !data) return { ok: false, error: mapInventoryError(error ?? {}, "closeInventorySession") };
  const r = data as Record<string, unknown>;
  return {
    ok: true,
    data: {
      sessionId: String(r.session_id),
      status: r.status as SessionStatus,
      uncountedLocations: num(r.uncounted_locations),
      unapprovedCounts: num(r.unapproved_counts),
      idempotentReplay: r.idempotent_replay === true,
    },
  };
}

export async function cancelInventorySession(
  db: Db,
  sessionId: string,
  input: CancelSessionInput,
): Promise<InventoryResult<{ sessionId: string; status: SessionStatus; idempotentReplay: boolean }>> {
  const { data, error } = await db.rpc("inventory_cancel_session", {
    p_client_request_id: input.client_request_id,
    p_session_id: sessionId,
    p_reason: input.reason ?? null,
  });
  if (error || !data) return { ok: false, error: mapInventoryError(error ?? {}, "cancelInventorySession") };
  const r = data as Record<string, unknown>;
  return { ok: true, data: { sessionId: String(r.session_id), status: r.status as SessionStatus, idempotentReplay: r.idempotent_replay === true } };
}

// ---------------------------------------------------------------------------
// Odczyty bez stanów systemowych (każda aktywna rola)
// ---------------------------------------------------------------------------
export type SessionListItemDto = {
  id: string;
  name: string;
  note: string | null;
  status: SessionStatus;
  createdAt: string;
  createdByName: string;
  closedAt: string | null;
  cancelledAt: string | null;
  locationCount: number;
  countedLocationCount: number;
};

export async function listInventorySessions(db: Db, status?: SessionStatus): Promise<InventoryResult<SessionListItemDto[]>> {
  const { data, error } = await db.rpc("inventory_sessions_list", { p_status: status ?? null });
  if (error || !Array.isArray(data)) return { ok: false, error: mapInventoryError(error ?? {}, "listInventorySessions") };
  return {
    ok: true,
    data: (data as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      name: String(r.name),
      note: (r.note as string | null) ?? null,
      status: r.status as SessionStatus,
      createdAt: String(r.created_at),
      createdByName: String(r.created_by_name ?? ""),
      closedAt: (r.closed_at as string | null) ?? null,
      cancelledAt: (r.cancelled_at as string | null) ?? null,
      locationCount: num(r.location_count),
      countedLocationCount: num(r.counted_location_count),
    })),
  };
}

export type SessionHeaderDto = {
  id: string;
  name: string;
  note: string | null;
  status: SessionStatus;
  createdAt: string;
  createdByName: string;
  closedAt: string | null;
  closedByName: string | null;
  cancelledAt: string | null;
  cancelledByName: string | null;
  cancelReason: string | null;
};
export type SessionLocationDto = {
  locationId: string;
  code: string;
  name: string | null;
  active: boolean;
  countedAt: string | null;
  countedByName: string | null;
  itemCount: number;
};
export type SessionOverviewDto = { session: SessionHeaderDto; locations: SessionLocationDto[] };

export async function getSessionOverview(db: Db, sessionId: string): Promise<InventoryResult<SessionOverviewDto>> {
  const { data, error } = await db.rpc("inventory_session_overview", { p_session_id: sessionId });
  if (error || !data) return { ok: false, error: mapInventoryError(error ?? {}, "getSessionOverview") };
  const r = data as { session: Record<string, unknown>; locations: Record<string, unknown>[] };
  const s = r.session;
  return {
    ok: true,
    data: {
      session: {
        id: String(s.id),
        name: String(s.name),
        note: (s.note as string | null) ?? null,
        status: s.status as SessionStatus,
        createdAt: String(s.created_at),
        createdByName: String(s.created_by_name ?? ""),
        closedAt: (s.closed_at as string | null) ?? null,
        closedByName: (s.closed_by_name as string | null) ?? null,
        cancelledAt: (s.cancelled_at as string | null) ?? null,
        cancelledByName: (s.cancelled_by_name as string | null) ?? null,
        cancelReason: (s.cancel_reason as string | null) ?? null,
      },
      locations: (r.locations ?? []).map((l) => ({
        locationId: String(l.location_id),
        code: String(l.code),
        name: (l.name as string | null) ?? null,
        active: l.active === true,
        countedAt: (l.counted_at as string | null) ?? null,
        countedByName: (l.counted_by_name as string | null) ?? null,
        itemCount: num(l.item_count),
      })),
    },
  };
}

/** Pozycja na ekranie liczenia — BEZ stanu systemowego (liczenie na ślepo). */
export type CountingItemDto = {
  materialId: string;
  code: string;
  name: string;
  unit: string;
  allowsFraction: boolean;
  active: boolean;
  /** System oczekuje materiału w tej lokalizacji (bez ilości). */
  expected: boolean;
  countedQuantity: number | null;
  countedAt: string | null;
  countedByName: string | null;
  state: "COUNTED" | "RECOUNT" | "APPROVED" | null;
};
export type CountingLocationDto = {
  session: { id: string; name: string; status: SessionStatus };
  location: { id: string; code: string; name: string | null; active: boolean };
  countedAt: string | null;
  countedByName: string | null;
  /** Czas serwera — znacznik rozpoczęcia liczenia (odsyłany przy zapisie). */
  serverTime: string;
  /** Wersja lokalizacji (licznik zapisów) — odsyłana przy zapisie (kontrola zapisu przez dwie osoby). */
  locationVersion: number;
  items: CountingItemDto[];
};

export async function getCountingLocation(db: Db, sessionId: string, locationId: string): Promise<InventoryResult<CountingLocationDto>> {
  const { data, error } = await db.rpc("inventory_counting_location", { p_session_id: sessionId, p_location_id: locationId });
  if (error || !data) return { ok: false, error: mapInventoryError(error ?? {}, "getCountingLocation") };
  const r = data as {
    session: { id: string; name: string; status: SessionStatus };
    location: { id: string; code: string; name: string | null; active: boolean };
    counted_at: string | null;
    counted_by_name: string | null;
    server_time: string;
    location_version: number;
    items: Record<string, unknown>[];
  };
  return {
    ok: true,
    data: {
      session: { id: r.session.id, name: r.session.name, status: r.session.status },
      location: { id: r.location.id, code: r.location.code, name: r.location.name ?? null, active: r.location.active === true },
      countedAt: r.counted_at ?? null,
      countedByName: r.counted_by_name ?? null,
      serverTime: String(r.server_time),
      locationVersion: num(r.location_version),
      // Jawne mapowanie pól — żadne dane spoza listy nie trafią do liczącego.
      items: (r.items ?? []).map((i) => ({
        materialId: String(i.material_id),
        code: String(i.code),
        name: String(i.name),
        unit: String(i.unit),
        allowsFraction: i.allows_fraction === true,
        active: i.active === true,
        expected: i.expected === true,
        countedQuantity: numOrNull(i.counted_quantity),
        countedAt: (i.counted_at as string | null) ?? null,
        countedByName: (i.counted_by_name as string | null) ?? null,
        state: (i.state as CountingItemDto["state"]) ?? null,
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Odczyty ze stanem systemowym (BIURO, ADMIN)
// ---------------------------------------------------------------------------
export type ReviewRowDto = {
  countId: string | null;
  locationId: string;
  locationCode: string;
  locationName: string | null;
  locationActive: boolean;
  materialId: string;
  materialCode: string;
  materialName: string;
  unit: string;
  allowsFraction: boolean;
  materialActive: boolean;
  systemQuantity: number;
  countedQuantity: number | null;
  difference: number | null;
  status: ReviewStatus;
  blockedReason: string | null;
  countedByName: string | null;
  countedAt: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  operationId: string | null;
  operationReversed: boolean;
  materialStockActive: number;
  materialReserved: number;
};

export async function getSessionReview(db: Db, sessionId: string): Promise<InventoryResult<ReviewRowDto[]>> {
  const { data, error } = await db.rpc("inventory_session_review", { p_session_id: sessionId });
  if (error || !Array.isArray(data)) return { ok: false, error: mapInventoryError(error ?? {}, "getSessionReview") };
  return {
    ok: true,
    data: (data as Record<string, unknown>[]).map((r) => ({
      countId: (r.count_id as string | null) ?? null,
      locationId: String(r.location_id),
      locationCode: String(r.location_code),
      locationName: (r.location_name as string | null) ?? null,
      locationActive: r.location_active === true,
      materialId: String(r.material_id),
      materialCode: String(r.material_code),
      materialName: String(r.material_name),
      unit: String(r.unit),
      allowsFraction: r.allows_fraction === true,
      materialActive: r.material_active === true,
      systemQuantity: num(r.system_quantity),
      countedQuantity: numOrNull(r.counted_quantity),
      difference: numOrNull(r.difference),
      status: r.status as ReviewStatus,
      blockedReason: (r.blocked_reason as string | null) ?? null,
      countedByName: (r.counted_by_name as string | null) ?? null,
      countedAt: (r.counted_at as string | null) ?? null,
      approvedByName: (r.approved_by_name as string | null) ?? null,
      approvedAt: (r.approved_at as string | null) ?? null,
      operationId: (r.operation_id as string | null) ?? null,
      operationReversed: r.operation_reversed === true,
      materialStockActive: num(r.material_stock_active),
      materialReserved: num(r.material_reserved),
    })),
  };
}

export type CountEventDto = {
  id: string;
  createdAt: string;
  kind: "COUNT" | "REMOVE" | "RECOUNT" | "APPROVE" | "MATCH";
  locationCode: string;
  materialCode: string;
  unit: string;
  countedQuantity: number | null;
  previousQuantity: number | null;
  operationId: string | null;
  userName: string;
};

export async function getSessionEvents(db: Db, sessionId: string): Promise<InventoryResult<CountEventDto[]>> {
  const { data, error } = await db.rpc("inventory_session_events", { p_session_id: sessionId });
  if (error || !Array.isArray(data)) return { ok: false, error: mapInventoryError(error ?? {}, "getSessionEvents") };
  return {
    ok: true,
    data: (data as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      createdAt: String(r.created_at),
      kind: r.kind as CountEventDto["kind"],
      locationCode: String(r.location_code),
      materialCode: String(r.material_code),
      unit: String(r.unit),
      countedQuantity: numOrNull(r.counted_quantity),
      previousQuantity: numOrNull(r.previous_quantity),
      operationId: (r.operation_id as string | null) ?? null,
      userName: String(r.user_name ?? ""),
    })),
  };
}

export async function exportInventoryCsv(
  db: Db,
  sessionId: string,
  onlyDiff: boolean,
  now = new Date(),
): Promise<InventoryResult<{ filename: string; body: string }>> {
  const { data, error } = await db.rpc("export_inventory_csv", { p_session_id: sessionId, p_only_diff: onlyDiff });
  if (error || typeof data !== "string") return { ok: false, error: mapInventoryError(error ?? {}, "exportInventoryCsv") };
  return {
    ok: true,
    data: { filename: `inwentaryzacja${onlyDiff ? "-roznice" : ""}_${fileTimestamp(now)}.csv`, body: data },
  };
}
