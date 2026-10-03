"use client";

import { useSyncExternalStore } from "react";
import type { PickedMaterial } from "@/components/material-picker";
import type { IssuePayload, OperationKind, PayloadOf, ReceiptPayload, TransferPayload } from "./stock-client";

// Niepotwierdzona operacja na terminalu (ADR 009 M4, ADR 010) — jeden mechanizm dla przyjęcia, wydania
// i przesunięcia. Zapisywana w sessionStorage (osobny klucz na typ) od chwili wysłania do potwierdzenia przez
// serwer (sukces albo jednoznaczne odrzucenie). Po utracie odpowiedzi, odświeżeniu strony albo ponownym
// zalogowaniu (401) pracownik może ją dokończyć tym samym client_request_id — bez ryzyka duplikatu
// (idempotencja w bazie). Brak/awaria storage: kopia w pamięci.

export type PendingLocation = { id: string; code: string; name: string | null };
/** Cel wydania: zlecenie albo powód (kod + etykieta + opis). */
export type IssueTarget =
  | { kind: "order"; id: string; name: string; /** Data utworzenia i notatka — nazwy zleceń mogą się powtarzać. */ sub?: string | null }
  | { kind: "reason"; code: string; label: string; text: string | null };

type ContextOf<K extends OperationKind> = K extends "RECEIPT"
  ? { location: PendingLocation; material: PickedMaterial; supplierName: string | null }
  : K extends "ISSUE"
    ? {
        location: PendingLocation;
        material: PickedMaterial;
        target: IssueTarget;
        /** Etap 12b: wydanie zamiennika — oryginał z zapotrzebowania (zgodny z payload.substitute_for). */
        substituteFor?: { id: string; code: string; name: string } | null;
      }
    : { from: PendingLocation; to: PendingLocation; material: PickedMaterial };

export type PendingOperation<K extends OperationKind = OperationKind> = {
  v: 2;
  kind: K;
  userId: string;
  requestId: string;
  payload: PayloadOf<K>;
  ctx: ContextOf<K>;
  savedAt: number;
};

export const PENDING_KEYS: Record<OperationKind, string> = {
  RECEIPT: "forbud.pending.RECEIPT",
  ISSUE: "forbud.pending.ISSUE",
  TRANSFER: "forbud.pending.TRANSFER",
};
export const OPERATION_KINDS: OperationKind[] = ["RECEIPT", "ISSUE", "TRANSFER"];
/** Starsze niż doba — nie proponujemy dokończenia (pracownik i tak nie pamięta kontekstu). */
export const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isLoc = (v: unknown, id: unknown): boolean => isObj(v) && isStr(v.code) && isStr(v.id) && v.id === id;

/**
 * Czysta walidacja zapisu: kształt, typ, właściciel (ten sam użytkownik), wiek (gdy podano `now`) i zgodność
 * kontekstu wyświetlanego z payloadem (żeby ekran „Ponów” pokazywał dokładnie to, co zostanie wysłane).
 */
export function parsePending<K extends OperationKind>(
  raw: string | null,
  kind: K,
  userId: string,
  now?: number,
): PendingOperation<K> | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(v) || v.v !== 2 || v.kind !== kind || v.userId !== userId || !isStr(v.requestId)) return null;
  if (typeof v.savedAt !== "number") return null;
  if (now !== undefined && (now - v.savedAt > PENDING_MAX_AGE_MS || v.savedAt - now > 60_000)) return null;
  const p = v.payload;
  const c = v.ctx;
  if (!isObj(p) || !isObj(c) || p.client_request_id !== v.requestId || !isStr(p.material_id)) return null;
  if (typeof p.quantity !== "number" || !(p.quantity > 0)) return null;
  if (!isObj(c.material) || !isStr(c.material.code) || !isStr(c.material.unit) || c.material.id !== p.material_id) return null;

  if (kind === "RECEIPT") {
    if (!isLoc(c.location, (p as ReceiptPayload).location_id)) return null;
  } else if (kind === "ISSUE") {
    const ip = p as IssuePayload;
    if (!isLoc(c.location, ip.location_id)) return null;
    const t = c.target;
    if (!isObj(t)) return null;
    if (t.kind === "order") {
      if (!isStr(t.id) || t.id !== ip.production_order_id || !isStr(t.name) || ip.reason_code) return null;
    } else if (t.kind === "reason") {
      if (!isStr(t.code) || t.code !== ip.reason_code || ip.production_order_id) return null;
    } else {
      return null;
    }
    // Zamiennik: kontekst (co pokazujemy) musi odpowiadać temu, co zostanie wysłane.
    const sf = c.substituteFor;
    const sfId = isObj(sf) && isStr(sf.id) && isStr(sf.code) ? sf.id : null;
    if ((sf !== undefined && sf !== null && sfId === null) || sfId !== (ip.substitute_for ?? null)) return null;
  } else {
    const tp = p as TransferPayload;
    if (!isLoc(c.from, tp.from_location_id) || !isLoc(c.to, tp.to_location_id)) return null;
  }
  return v as PendingOperation<K>;
}

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** Kopia w pamięci — gdy storage jest niedostępny, ekran nadal wie o niepotwierdzonej operacji. */
const memory: Record<OperationKind, string | null> = { RECEIPT: null, ISSUE: null, TRANSFER: null };

function readRaw(kind: OperationKind): string | null {
  try {
    return window.sessionStorage.getItem(PENDING_KEYS[kind]);
  } catch {
    return null;
  }
}

export function savePending<K extends OperationKind>(p: PendingOperation<K>): void {
  const raw = JSON.stringify(p);
  memory[p.kind] = raw;
  try {
    window.sessionStorage.setItem(PENDING_KEYS[p.kind], raw);
  } catch {
    // brak storage (tryb prywatny, blokada) — zostaje kopia w pamięci
  }
  notify();
}

export function clearPending(kind: OperationKind): void {
  memory[kind] = null;
  try {
    window.sessionStorage.removeItem(PENDING_KEYS[kind]);
  } catch {
    // jw.
  }
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const keys = new Set(Object.values(PENDING_KEYS));
  const onStorage = (e: StorageEvent) => e.key !== null && keys.has(e.key) && listener();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Surowy zapis (stabilny string) albo null; przeterminowany (> doba) jest pomijany już przy odczycie. */
function snapshot(kind: OperationKind): string | null {
  const raw = readRaw(kind) ?? memory[kind];
  if (!raw) return null;
  try {
    const savedAt = (JSON.parse(raw) as { savedAt?: unknown }).savedAt;
    if (typeof savedAt !== "number" || Date.now() - savedAt > PENDING_MAX_AGE_MS) return null;
  } catch {
    return null;
  }
  return raw;
}
const SNAPSHOTS: Record<OperationKind, () => string | null> = {
  RECEIPT: () => snapshot("RECEIPT"),
  ISSUE: () => snapshot("ISSUE"),
  TRANSFER: () => snapshot("TRANSFER"),
};
const getServerSnapshot = () => null;

/** Niepotwierdzona operacja danego typu bieżącego użytkownika (null na serwerze i gdy brak). */
export function usePendingOperation<K extends OperationKind>(kind: K, userId: string): PendingOperation<K> | null {
  const raw = useSyncExternalStore(subscribe, SNAPSHOTS[kind], getServerSnapshot);
  return parsePending(raw, kind, userId);
}
