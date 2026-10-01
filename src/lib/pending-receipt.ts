"use client";

import { useSyncExternalStore } from "react";
import type { PickedMaterial } from "@/components/material-picker";
import type { ReceiptPayload } from "./stock-client";

// Niepotwierdzone przyjęcie na terminalu (ADR 009, M4). Zapisywane w sessionStorage od chwili wysłania
// do potwierdzenia przez serwer (sukces albo jednoznaczne odrzucenie). Po utracie odpowiedzi, odświeżeniu
// strony albo ponownym zalogowaniu (401) pracownik może je dokończyć tym samym client_request_id —
// bez ryzyka duplikatu (idempotencja w bazie). Brak/awaria storage: działa jak dotąd (tylko w pamięci).

export type PendingReceipt = {
  v: 1;
  userId: string;
  requestId: string;
  payload: ReceiptPayload;
  location: { id: string; code: string; name: string | null };
  material: PickedMaterial;
  supplierName: string | null;
  savedAt: number;
};

export const PENDING_KEY = "forbud.pendingReceipt";
/** Starsze niż doba — nie proponujemy dokończenia (pracownik i tak nie pamięta kontekstu). */
export const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Czysta walidacja zapisu: kształt, właściciel (ten sam użytkownik), wiek (gdy podano `now`). Niepoprawny → null. */
export function parsePending(raw: string | null, userId: string, now?: number): PendingReceipt | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(v) || v.v !== 1 || v.userId !== userId || !isStr(v.requestId)) return null;
  if (typeof v.savedAt !== "number") return null;
  if (now !== undefined && (now - v.savedAt > PENDING_MAX_AGE_MS || v.savedAt - now > 60_000)) return null;
  const p = v.payload;
  if (!isObj(p) || p.client_request_id !== v.requestId || !isStr(p.location_id) || !isStr(p.material_id)) return null;
  if (typeof p.quantity !== "number" || !(p.quantity > 0)) return null;
  if (!isObj(v.location) || !isStr(v.location.code) || v.location.id !== p.location_id) return null;
  if (!isObj(v.material) || !isStr(v.material.code) || !isStr(v.material.unit) || v.material.id !== p.material_id) return null;
  return v as PendingReceipt;
}

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function readRaw(): string | null {
  try {
    return window.sessionStorage.getItem(PENDING_KEY);
  } catch {
    return null;
  }
}

/** Kopia w pamięci — gdy storage jest niedostępny, ekran nadal wie o niepotwierdzonej operacji. */
let memory: string | null = null;

export function savePending(p: PendingReceipt): void {
  memory = JSON.stringify(p);
  try {
    window.sessionStorage.setItem(PENDING_KEY, memory);
  } catch {
    // brak storage (tryb prywatny, blokada) — zostaje kopia w pamięci
  }
  notify();
}

export function clearPending(): void {
  memory = null;
  try {
    window.sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // jw.
  }
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => e.key === PENDING_KEY && listener();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Surowy zapis (stabilny string) albo null; przeterminowany (> doba) jest pomijany już przy odczycie. */
function getSnapshot(): string | null {
  const raw = readRaw() ?? memory;
  if (!raw) return null;
  try {
    const savedAt = (JSON.parse(raw) as { savedAt?: unknown }).savedAt;
    if (typeof savedAt !== "number" || Date.now() - savedAt > PENDING_MAX_AGE_MS) return null;
  } catch {
    return null;
  }
  return raw;
}
const getServerSnapshot = () => null;

/** Niepotwierdzone przyjęcie bieżącego użytkownika (null na serwerze i gdy brak). */
export function usePendingReceipt(userId: string): PendingReceipt | null {
  const raw = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return parsePending(raw, userId);
}
