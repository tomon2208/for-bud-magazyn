"use client";

import type { ApproveResultDto, CountingLocationDto, CreateSessionResultDto, SaveCountResultDto } from "@/server/inventory";
import { postStockOperation, type SubmitResult } from "./stock-client";

// Klient inwentaryzacji (przeglądarka). Zapisy przez postStockOperation: błąd sieci / 5xx / RETRY = wynik nieznany
// (ponowienie z TYM SAMYM client_request_id — idempotencja w bazie), 401 = sesja wygasła, reszta = błąd domenowy.

export type CreateSessionPayload = {
  client_request_id: string;
  name: string;
  note?: string | null;
  location_ids?: string[];
  code_prefix?: string;
  all_locations?: true;
};
export type SaveCountPayload = {
  client_request_id: string;
  started_at: string;
  location_version: number;
  items: { material_id: string; quantity: number }[];
};
export type ApprovePayload = { client_request_id: string; count_ids: string[]; expected_counts: Record<string, number> };
export type SessionActionPayload = { client_request_id: string; reason?: string | null };

const base = (sessionId: string) => `/api/v1/inventory/sessions/${encodeURIComponent(sessionId)}`;

export const submitCreateSession = (payload: CreateSessionPayload): Promise<SubmitResult<CreateSessionResultDto>> =>
  postStockOperation("/api/v1/inventory/sessions", payload, "Sesja logowania wygasła — zaloguj się i ponów.");

export const submitCount = (sessionId: string, locationId: string) => (payload: SaveCountPayload): Promise<SubmitResult<SaveCountResultDto>> =>
  postStockOperation(
    `${base(sessionId)}/locations/${encodeURIComponent(locationId)}/count`,
    payload,
    "Sesja wygasła — zaloguj się; liczenie tej lokalizacji nie zostało zapisane.",
  );

export const submitApprove = (sessionId: string) => (payload: ApprovePayload): Promise<SubmitResult<ApproveResultDto>> =>
  postStockOperation(`${base(sessionId)}/approve`, payload, "Sesja wygasła — zaloguj się i ponów zatwierdzenie.");

export const submitSessionAction = (sessionId: string, action: "close" | "cancel") => (payload: SessionActionPayload) =>
  postStockOperation<{ sessionId: string; status: string; uncountedLocations?: number; unapprovedCounts?: number }>(
    `${base(sessionId)}/${action}`,
    payload,
    "Sesja wygasła — zaloguj się i ponów.",
  );

export async function fetchCountingLocation(
  sessionId: string,
  locationId: string,
): Promise<{ kind: "ok"; data: CountingLocationDto } | { kind: "error"; status: number; message: string }> {
  try {
    const res = await fetch(`${base(sessionId)}/locations/${encodeURIComponent(locationId)}`, { cache: "no-store" });
    const json = (await res.json().catch(() => null)) as { data?: CountingLocationDto; error?: { message?: string } } | null;
    if (res.ok && json?.data) return { kind: "ok", data: json.data };
    if (res.status === 401) return { kind: "error", status: 401, message: "Sesja wygasła — zaloguj się ponownie." };
    return { kind: "error", status: res.status, message: json?.error?.message ?? `Błąd (${res.status})` };
  } catch {
    return { kind: "error", status: 0, message: "Brak połączenia z serwerem. Spróbuj ponownie." };
  }
}
