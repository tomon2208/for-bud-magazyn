"use client";

// Klient operacji magazynowych (przeglądarka). Rozróżnia błąd SIECI (wynik nieznany — ponów z tym samym
// client_request_id) od błędu DOMENOWEGO (serwer odrzucił — popraw dane). Odpowiedź 5xx też traktujemy
// jako „wynik nieznany”: ponowienie z tym samym id jest bezpieczne (idempotencja w bazie).

export type ReceiptResponse = {
  operationId: string;
  movementId: string;
  materialId: string;
  locationId: string;
  quantity: number;
  newLocationQuantity: number;
  idempotentReplay: boolean;
};

export type SubmitResult<T> =
  | { kind: "ok"; data: T }
  | { kind: "network"; message: string }
  | { kind: "auth"; message: string }
  | { kind: "error"; status: number; code: string; message: string };

export type ReceiptPayload = {
  client_request_id: string;
  location_id: string;
  material_id: string;
  quantity: number;
  supplier_id?: string | null;
  document_ref?: string | null;
  note?: string | null;
};

export async function submitReceipt(payload: ReceiptPayload): Promise<SubmitResult<ReceiptResponse>> {
  let res: Response;
  try {
    res = await fetch("/api/v1/stock/receipts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    return { kind: "network", message: "Brak połączenia z serwerem. Operacja mogła nie zostać zapisana." };
  }
  const json = (await res.json().catch(() => null)) as {
    data?: ReceiptResponse;
    error?: { code?: string; message?: string };
  } | null;
  if (res.ok && json?.data) return { kind: "ok", data: json.data };
  if (res.status >= 500 || !json) {
    return { kind: "network", message: "Serwer nie odpowiedział poprawnie. Nie wiadomo, czy operacja została zapisana." };
  }
  if (res.status === 401) {
    // Operacja nie została wykonana (brak sesji), ale jej nie porzucamy — po zalogowaniu można ją dokończyć.
    return { kind: "auth", message: "Sesja wygasła — zaloguj się; przyjęcie zostanie dokończone." };
  }
  if (res.status === 409 && json.error?.code === "RETRY") {
    // unique(client_request_id) — operacja w toku albo już zapisana: wynik nieznany, ponowienie tym samym id.
    return { kind: "network", message: "Operacja jest w toku albo została już zapisana. Ponów — nie zostanie zdublowana." };
  }
  return {
    kind: "error",
    status: res.status,
    code: json.error?.code ?? "ERROR",
    message: json.error?.message ?? `Błąd (${res.status})`,
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
