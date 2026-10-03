import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReleaseInput, ReserveInput } from "@/lib/validation/reservations";
import type { ServiceError, ServiceResult } from "./users";

// Rezerwacje materiału dla zleceń (Etap 11, ADR 014). Zapis: funkcje DB reserve_for_order / release_reservation
// (BIURO, ADMIN; klient UŻYTKOWNIKA — auth.uid() = autor zdarzenia). Odczyty liczy baza.

type Db = SupabaseClient;
type DbError = { code?: string; message?: string; hint?: string | null; details?: string | null };
export type ReservationError = ServiceError & { details?: Record<string, unknown> };
export type ReservationResult<T> = { ok: true; data: T } | { ok: false; error: ReservationError };

const INTERNAL: ServiceError = { status: 500, code: "INTERNAL", message: "Wystąpił błąd serwera. Spróbuj ponownie." };
const plQty = (n: number) => n.toLocaleString("pl-PL", { maximumFractionDigits: 3 });
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function parseDetail(details: string | null | undefined): Record<string, unknown> {
  try {
    const v = JSON.parse(details ?? "{}") as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function mapReservationError(error: DbError, context: string): ReservationError {
  if (error.code === "42501") return { status: 403, code: "FORBIDDEN", message: "Brak uprawnień" };
  if (error.code === "P0001" && error.hint) {
    switch (error.hint) {
      case "NOT_FOUND":
        return { status: 404, code: "NOT_FOUND", message: error.details === "material" ? "Nie znaleziono materiału" : "Nie znaleziono zlecenia" };
      case "ORDER_NOT_OPEN":
        return { status: 409, code: "ORDER_NOT_OPEN", message: "Zlecenie jest zakończone lub anulowane — nie można rezerwować" };
      case "IDEMPOTENCY_CONFLICT":
        return { status: 409, code: "IDEMPOTENCY_CONFLICT", message: "Ten identyfikator żądania został już użyty. Odśwież ekran." };
      case "NOT_IN_REQUIREMENTS":
        return {
          status: 400,
          code: "NOT_IN_REQUIREMENTS",
          message: `Materiał ${error.details ?? ""} nie występuje w zapotrzebowaniu zlecenia`,
        };
      case "RESERVE_EXCEEDS_FREE":
      case "RESERVE_EXCEEDS_REMAINING": {
        const d = parseDetail(error.details);
        const code = typeof d.material_code === "string" ? d.material_code : "";
        const free = num(d.free);
        const toReserve = num(d.to_reserve);
        return {
          status: 409,
          code: error.hint,
          message:
            error.hint === "RESERVE_EXCEEDS_FREE"
              ? `${code}: można zarezerwować najwyżej ${plQty(free)} (wolny stan)`
              : `${code}: pozostało do zarezerwowania tylko ${plQty(toReserve)}`,
          details: { materialCode: code, free, toReserve },
        };
      }
      case "RELEASE_EXCEEDS": {
        const reserved = num(error.details);
        return {
          status: 409,
          code: "RELEASE_EXCEEDS",
          message: `Nie można zwolnić więcej niż zarezerwowano (${plQty(reserved)})`,
          details: { reserved },
        };
      }
      case "NOTHING_TO_RELEASE":
        return { status: 409, code: "NOTHING_TO_RELEASE", message: "Brak rezerwacji do zwolnienia" };
      case "DUPLICATE_MATERIAL":
        return { status: 400, code: "DUPLICATE_MATERIAL", message: "Ten sam materiał występuje więcej niż raz" };
      case "NOT_INTEGER":
        return { status: 400, code: "NOT_INTEGER", message: `Materiał ${error.details ?? ""} liczy się w całych jednostkach` };
      case "INVALID_QUANTITY":
        return { status: 400, code: "INVALID_QUANTITY", message: "Ilość musi być większa od zera, maksymalnie 1 000 000, do 3 miejsc po przecinku" };
      case "VALIDATION":
        return { status: 400, code: "VALIDATION", message: "Nieprawidłowe dane" };
    }
  }
  if (error.code === "22P02" || error.code === "23514") return { status: 400, code: "VALIDATION", message: "Nieprawidłowe dane" };
  if (error.code === "23505") return { status: 409, code: "RETRY", message: "Operacja jest w toku. Spróbuj ponownie za chwilę." };
  console.error(context, error.code ?? "unknown");
  return INTERNAL;
}

// ---------------------------------------------------------------------------
// Zapis
// ---------------------------------------------------------------------------
export type ReserveResultDto = {
  reserved: { materialId: string; materialCode: string; quantity: number; reservedTotal: number }[];
  notReserved: { materialId: string; materialCode: string; missing: number }[];
  idempotentReplay: boolean;
};

export async function reserveForOrder(db: Db, orderId: string, input: ReserveInput): Promise<ReservationResult<ReserveResultDto>> {
  const { data, error } = await db.rpc("reserve_for_order", {
    p_client_request_id: input.client_request_id,
    p_order_id: orderId,
    p_items: input.items && input.items.length > 0 ? input.items.map((i) => ({ material_id: i.material_id, quantity: i.quantity })) : null,
  });
  if (error || !data) return { ok: false, error: mapReservationError(error ?? {}, "reserveForOrder") };
  const r = data as {
    reserved: { material_id: string; material_code: string; quantity: unknown; reserved_total: unknown }[];
    not_reserved: { material_id: string; material_code: string; missing: unknown }[];
    idempotent_replay: boolean;
  };
  return {
    ok: true,
    data: {
      reserved: (r.reserved ?? []).map((x) => ({
        materialId: x.material_id,
        materialCode: x.material_code,
        quantity: num(x.quantity),
        reservedTotal: num(x.reserved_total),
      })),
      notReserved: (r.not_reserved ?? []).map((x) => ({ materialId: x.material_id, materialCode: x.material_code, missing: num(x.missing) })),
      idempotentReplay: r.idempotent_replay === true,
    },
  };
}

export type ReleaseResultDto = {
  released: { materialId: string; materialCode: string; quantity: number; reservedAfter: number }[];
  idempotentReplay: boolean;
};

export async function releaseReservation(db: Db, orderId: string, input: ReleaseInput): Promise<ReservationResult<ReleaseResultDto>> {
  const { data, error } = await db.rpc("release_reservation", {
    p_client_request_id: input.client_request_id,
    p_order_id: orderId,
    p_material_id: input.material_id ?? null,
    p_quantity: input.quantity ?? null,
    p_reason: input.reason ?? null,
  });
  if (error || !data) return { ok: false, error: mapReservationError(error ?? {}, "releaseReservation") };
  const r = data as {
    released: { material_id: string; material_code: string; quantity: unknown; reserved_after: unknown }[];
    idempotent_replay: boolean;
  };
  return {
    ok: true,
    data: {
      released: (r.released ?? []).map((x) => ({
        materialId: x.material_id,
        materialCode: x.material_code,
        quantity: num(x.quantity),
        reservedAfter: num(x.reserved_after),
      })),
      idempotentReplay: r.idempotent_replay === true,
    },
  };
}

// ---------------------------------------------------------------------------
// Odczyty
// ---------------------------------------------------------------------------
export type OrderReservationDto = {
  materialId: string;
  materialCode: string;
  materialName: string;
  unit: string;
  allowsFraction: boolean;
  needed: number;
  issued: number;
  remaining: number;
  /** Zarezerwowane dla tego zlecenia. */
  reserved: number;
  /** Pozostało do zarezerwowania = max(pozostało − zarezerwowane, 0). */
  toReserve: number;
  /** Rezerwacja ponad „pozostało” (np. po wycofaniu listy) — do decyzji BIURA. */
  excess: number;
  stockActive: number;
  reservedTotal: number;
  /** Wolne w magazynie (wspólne dla wszystkich zleceń). */
  free: number;
  /** Σ rezerwacji materiału > stan (po korekcie/stornie w dół). */
  overReserved: boolean;
};
export type ReservationEventDto = {
  id: string;
  createdAt: string;
  type: "RESERVE" | "RELEASE" | "CONSUME" | "OVERRIDE" | "AUTO_RELEASE" | "SUBSTITUTE_RELEASE";
  materialId: string;
  materialCode: string;
  unit: string;
  quantityDelta: number;
  quantityAfter: number;
  reason: string | null;
  operationId: string | null;
  userName: string | null;
  /** OVERRIDE: zlecenie (albo brak — wydanie bez zlecenia), na które wydano towar. */
  operationOrderName: string | null;
};

export async function getOrderReservations(
  db: Db,
  orderId: string,
): Promise<ServiceResult<{ items: OrderReservationDto[]; events: ReservationEventDto[] }>> {
  const [rows, events] = await Promise.all([
    db.rpc("order_reservations", { p_order_id: orderId }),
    db.rpc("order_reservation_events", { p_order_id: orderId }),
  ]);
  const err = rows.error ?? events.error;
  if (err) return { ok: false, error: mapReservationError(err, "getOrderReservations") };
  return {
    ok: true,
    data: {
      items: ((rows.data ?? []) as Record<string, unknown>[]).map((r) => ({
        materialId: r.material_id as string,
        materialCode: r.material_code as string,
        materialName: r.material_name as string,
        unit: r.unit as string,
        allowsFraction: r.allows_fraction === true,
        needed: num(r.needed),
        issued: num(r.issued),
        remaining: num(r.remaining),
        reserved: num(r.reserved),
        toReserve: num(r.to_reserve),
        excess: num(r.excess),
        stockActive: num(r.stock_active),
        reservedTotal: num(r.reserved_total),
        free: num(r.free),
        overReserved: r.over_reserved === true,
      })),
      events: ((events.data ?? []) as Record<string, unknown>[]).map((e) => ({
        id: e.id as string,
        createdAt: e.created_at as string,
        type: e.type as ReservationEventDto["type"],
        materialId: e.material_id as string,
        materialCode: e.material_code as string,
        unit: e.unit as string,
        quantityDelta: num(e.quantity_delta),
        quantityAfter: num(e.quantity_after),
        reason: (e.reason as string | null) ?? null,
        operationId: (e.operation_id as string | null) ?? null,
        userName: (e.user_name as string | null) ?? null,
        operationOrderName: (e.operation_order_name as string | null) ?? null,
      })),
    },
  };
}

export type MaterialAvailabilityDto = {
  materialId: string;
  stockActive: number;
  reservedTotal: number;
  free: number;
  ownReserved: number;
  /** Ile można wydać (na wskazane zlecenie: wolne + jego rezerwacja; bez zlecenia: wolne) — łącznie, bez lokalizacji. */
  availableForIssue: number;
  overReserved: boolean;
  orders: { orderId: string; number: string | null; name: string; status: string; quantity: number }[];
};

export async function getMaterialAvailability(
  db: Db,
  materialId: string,
  orderId?: string | null,
): Promise<ServiceResult<MaterialAvailabilityDto>> {
  const { data, error } = await db.rpc("material_availability", { p_material_id: materialId, p_order_id: orderId ?? null });
  if (error || !data) return { ok: false, error: mapReservationError(error ?? {}, "getMaterialAvailability") };
  const r = data as Record<string, unknown>;
  return {
    ok: true,
    data: {
      materialId,
      stockActive: num(r.stock_active),
      reservedTotal: num(r.reserved_total),
      free: num(r.free),
      ownReserved: num(r.own_reserved),
      availableForIssue: num(r.available_for_issue),
      overReserved: r.over_reserved === true,
      orders: ((r.orders ?? []) as Record<string, unknown>[]).map((o) => ({
        orderId: o.order_id as string,
        number: (o.number as string | null) ?? null,
        name: o.name as string,
        status: o.status as string,
        quantity: num(o.quantity),
      })),
    },
  };
}

export type OverReservedDto = { materialId: string; materialCode: string; materialName: string; unit: string; stockActive: number; reserved: number };

/** Materiały, których rezerwacje przekraczają stan (dashboard). ADMIN, BIURO. */
export async function listOverReserved(db: Db): Promise<ServiceResult<OverReservedDto[]>> {
  const { data, error } = await db.rpc("over_reserved_materials");
  if (error) return { ok: false, error: mapReservationError(error, "listOverReserved") };
  return {
    ok: true,
    data: ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      materialId: r.material_id as string,
      materialCode: r.material_code as string,
      materialName: r.material_name as string,
      unit: r.unit as string,
      stockActive: num(r.stock_active),
      reserved: num(r.reserved),
    })),
  };
}

// ---------------------------------------------------------------------------
// Rezerwacje ponad zapotrzebowanie (review Etapu 11, M1b)
// ---------------------------------------------------------------------------
export type OverRequirementDto = {
  orderId: string;
  orderNumber: string | null;
  orderName: string;
  materialId: string;
  materialCode: string;
  unit: string;
  reserved: number;
  remaining: number;
  excess: number;
};

/** Rezerwacje większe niż „pozostało do wydania” (np. po wycofaniu listy). `orderId` — tylko to zlecenie. ADMIN, BIURO. */
export async function listOverRequirement(db: Db, orderId?: string | null): Promise<ServiceResult<OverRequirementDto[]>> {
  const { data, error } = await db.rpc("reservations_over_requirement", { p_order_id: orderId ?? null });
  if (error) return { ok: false, error: mapReservationError(error, "listOverRequirement") };
  return {
    ok: true,
    data: ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      orderId: r.production_order_id as string,
      orderNumber: (r.order_number as string | null) ?? null,
      orderName: r.order_name as string,
      materialId: r.material_id as string,
      materialCode: r.material_code as string,
      unit: r.unit as string,
      reserved: num(r.reserved),
      remaining: num(r.remaining),
      excess: num(r.excess),
    })),
  };
}

/** „Zwolnij nadmiar”: zwalnia rezerwację ponad pozostało do wydania dla wszystkich materiałów zlecenia (jedna transakcja). */
export async function releaseReservationExcess(
  db: Db,
  orderId: string,
  clientRequestId: string,
): Promise<ReservationResult<ReleaseResultDto>> {
  const { data, error } = await db.rpc("release_reservation_excess", { p_client_request_id: clientRequestId, p_order_id: orderId });
  if (error || !data) return { ok: false, error: mapReservationError(error ?? {}, "releaseReservationExcess") };
  const r = data as { released: { material_id: string; material_code: string; quantity: unknown; reserved_after: unknown }[]; idempotent_replay: boolean };
  return {
    ok: true,
    data: {
      released: (r.released ?? []).map((x) => ({
        materialId: x.material_id,
        materialCode: x.material_code,
        quantity: num(x.quantity),
        reservedAfter: num(x.reserved_after),
      })),
      idempotentReplay: r.idempotent_replay === true,
    },
  };
}
