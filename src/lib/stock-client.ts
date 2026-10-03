"use client";

// Klient operacji magazynowych (przeglądarka) — jeden dla przyjęcia, wydania i przesunięcia. Rozróżnia błąd
// SIECI (wynik nieznany — ponów z tym samym client_request_id) od błędu DOMENOWEGO (serwer odrzucił — popraw
// dane). Odpowiedź 5xx też traktujemy jako „wynik nieznany”: ponowienie z tym samym id jest bezpieczne
// (idempotencja w bazie).

export type OperationKind = "RECEIPT" | "ISSUE" | "TRANSFER";

export type ReceiptResponse = {
  operationId: string;
  movementId: string;
  materialId: string;
  locationId: string;
  quantity: number;
  newLocationQuantity: number;
  idempotentReplay: boolean;
};

export type IssueResponse = {
  operationId: string;
  movementId: string;
  materialId: string;
  locationId: string;
  quantity: number;
  productionOrderId: string | null;
  reasonCode: string | null;
  remainingLocationQuantity: number;
  /** Etap 11: ile zużyto z rezerwacji zlecenia; rezerwacje innych zleceń zabrane przy wydaniu ADMIN-a mimo rezerwacji. */
  reservationConsumed?: number;
  reservationsOverridden?: { orderId: string; quantity: number }[];
  idempotentReplay: boolean;
};

export type TransferResponse = {
  operationId: string;
  materialId: string;
  fromLocationId: string;
  toLocationId: string;
  quantity: number;
  fromLocationQuantity: number;
  toLocationQuantity: number;
  idempotentReplay: boolean;
};

export type ReceiptPayload = {
  client_request_id: string;
  location_id: string;
  material_id: string;
  quantity: number;
  supplier_id?: string | null;
  document_ref?: string | null;
  note?: string | null;
};

export type IssuePayload = {
  client_request_id: string;
  location_id: string;
  material_id: string;
  quantity: number;
  production_order_id?: string | null;
  reason_code?: string | null;
  reason?: string | null;
  note?: string | null;
  /** Etap 11: wydanie mimo rezerwacji innych zleceń — tylko ADMIN, z powodem. */
  override_reservations?: boolean;
  override_reason?: string | null;
};

export type TransferPayload = {
  client_request_id: string;
  material_id: string;
  from_location_id: string;
  to_location_id: string;
  quantity: number;
  note?: string | null;
};

export type PayloadOf<K extends OperationKind> = K extends "RECEIPT"
  ? ReceiptPayload
  : K extends "ISSUE"
    ? IssuePayload
    : TransferPayload;
export type ResponseOf<K extends OperationKind> = K extends "RECEIPT"
  ? ReceiptResponse
  : K extends "ISSUE"
    ? IssueResponse
    : TransferResponse;

export type SubmitResult<T> =
  | { kind: "ok"; data: T }
  | { kind: "network"; message: string }
  | { kind: "auth"; message: string }
  | {
      kind: "error";
      status: number;
      code: string;
      message: string;
      available?: number;
      /** Pozostałe dane błędu domenowego, np. { current } przy STOCK_CHANGED, { locationCode } przy stornie. */
      details?: Record<string, unknown>;
    };

export const OPERATION_ENDPOINTS: Record<OperationKind, string> = {
  RECEIPT: "/api/v1/stock/receipts",
  ISSUE: "/api/v1/stock/issues",
  TRANSFER: "/api/v1/stock/transfers",
};

const AUTH_MESSAGES: Record<OperationKind, string> = {
  RECEIPT: "Sesja wygasła — zaloguj się; przyjęcie zostanie dokończone.",
  ISSUE: "Sesja wygasła — zaloguj się; wydanie zostanie dokończone.",
  TRANSFER: "Sesja wygasła — zaloguj się; przesunięcie zostanie dokończone.",
};

export async function submitOperation<K extends OperationKind>(
  kind: K,
  payload: PayloadOf<K>,
): Promise<SubmitResult<ResponseOf<K>>> {
  return postStockOperation<ResponseOf<K>>(OPERATION_ENDPOINTS[kind], payload, AUTH_MESSAGES[kind]);
}

// ---- korekta i storno (ADMIN) — ta sama obsługa wyniku nieznanego / 401 / błędu domenowego ----
export type AdjustmentPayload = {
  client_request_id: string;
  material_id: string;
  location_id: string;
  target_quantity: number;
  expected_current: number;
  reason_code: string;
  reason?: string | null;
  note?: string | null;
};
export type AdjustmentResponse = {
  operationId: string;
  movementId: string;
  materialId: string;
  locationId: string;
  previousQuantity: number;
  quantityDelta: number;
  newQuantity: number;
  idempotentReplay: boolean;
};
export type ReversalPayload = { client_request_id: string; operation_id: string; reason: string; note?: string | null };
export type ReversalResponse = {
  operationId: string;
  reversedOperationId: string;
  movements: { materialId: string; locationId: string; quantityDelta: number; newQuantity: number }[];
  idempotentReplay: boolean;
};

export const submitAdjustment = (payload: AdjustmentPayload) =>
  postStockOperation<AdjustmentResponse>(
    "/api/v1/stock/adjustments",
    payload,
    "Sesja wygasła — zaloguj się; korekta zostanie dokończona.",
  );

export const submitReversal = (payload: ReversalPayload) =>
  postStockOperation<ReversalResponse>(
    "/api/v1/stock/reversals",
    payload,
    "Sesja wygasła — zaloguj się; cofnięcie zostanie dokończone.",
  );

export async function postStockOperation<T>(url: string, payload: unknown, authMessage: string): Promise<SubmitResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    return { kind: "network", message: "Brak połączenia z serwerem. Operacja mogła nie zostać zapisana." };
  }
  const json = (await res.json().catch(() => null)) as {
    data?: T;
    error?: { code?: string; message?: string; details?: Record<string, unknown> };
  } | null;
  if (res.ok && json?.data) return { kind: "ok", data: json.data };
  if (res.status >= 500 || !json) {
    return { kind: "network", message: "Serwer nie odpowiedział poprawnie. Nie wiadomo, czy operacja została zapisana." };
  }
  if (res.status === 401) {
    // Operacja nie została wykonana (brak sesji), ale jej nie porzucamy — po zalogowaniu można ją dokończyć.
    return { kind: "auth", message: authMessage };
  }
  if (res.status === 409 && json.error?.code === "RETRY") {
    // unique(client_request_id) — operacja w toku albo już zapisana: wynik nieznany, ponowienie tym samym id.
    return { kind: "network", message: "Operacja jest w toku albo została już zapisana. Ponów — nie zostanie zdublowana." };
  }
  const available = json.error?.details?.available;
  return {
    kind: "error",
    status: res.status,
    code: json.error?.code ?? "ERROR",
    message: json.error?.message ?? `Błąd (${res.status})`,
    ...(typeof available === "number" ? { available } : {}),
    ...(json.error?.details ? { details: json.error.details } : {}),
  };
}

/** Lokalizacja po kodzie (skaner/ręczny wpis). */
export type ScannedLocation = { id: string; code: string; name: string | null; active: boolean };

export async function fetchLocationByCode(
  code: string,
): Promise<{ kind: "ok"; data: ScannedLocation } | { kind: "error"; message: string }> {
  try {
    const res = await fetch(`/api/v1/locations/by-code/${encodeURIComponent(code)}`);
    const json = (await res.json().catch(() => null)) as { data?: ScannedLocation; error?: { message?: string } } | null;
    if (res.ok && json?.data) return { kind: "ok", data: json.data };
    if (res.status === 404) return { kind: "error", message: `Nieznany kod lokalizacji: ${code}` };
    return { kind: "error", message: json?.error?.message ?? `Błąd (${res.status})` };
  } catch {
    return { kind: "error", message: "Brak połączenia z serwerem. Spróbuj ponownie." };
  }
}

/** Wiersz stanu (GET /api/v1/stock). */
export type StockRow = {
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
};

/** Stany > 0 dla materiału albo lokalizacji (wybór lokalizacji przy wydaniu / zawartość lokalizacji). */
export async function fetchStock(
  filter: { materialId?: string; locationId?: string },
): Promise<{ kind: "ok"; items: StockRow[] } | { kind: "error"; message: string }> {
  const params = new URLSearchParams({ pageSize: "500" });
  if (filter.materialId) params.set("materialId", filter.materialId);
  if (filter.locationId) params.set("locationId", filter.locationId);
  try {
    const res = await fetch(`/api/v1/stock?${params}`);
    const json = (await res.json().catch(() => null)) as { data?: { items: StockRow[] }; error?: { message?: string } } | null;
    if (res.ok && json?.data) return { kind: "ok", items: json.data.items };
    if (res.status === 401) return { kind: "error", message: "Sesja wygasła — zaloguj się ponownie." };
    return { kind: "error", message: json?.error?.message ?? `Błąd (${res.status})` };
  } catch {
    return { kind: "error", message: "Brak połączenia z serwerem. Spróbuj ponownie." };
  }
}

export type CurrentQuantity = { kind: "loading" } | { kind: "ok"; value: number } | { kind: "error"; message: string };

/** Aktualny stan materiału w lokalizacji (korekta) — 0, gdy nie ma wiersza > 0. */
export async function fetchCurrentQuantity(materialId: string, locationId: string): Promise<CurrentQuantity> {
  const r = await fetchStock({ materialId, locationId });
  if (r.kind === "error") return { kind: "error", message: r.message };
  return { kind: "ok", value: r.items.find((i) => i.locationId === locationId)?.quantity ?? 0 };
}
