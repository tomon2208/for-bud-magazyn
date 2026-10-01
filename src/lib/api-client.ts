"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

export type ApiResult =
  | { ok: true; data?: unknown }
  | { ok: false; message: string; fields: Record<string, string> };

type ErrorBody = { error?: { code?: string; message?: string; fields?: Record<string, string[]> } };

/** Błędy 409 (duplikat) pokazujemy przy właściwym polu formularza. */
const CONFLICT_FIELD: Record<string, string> = { CODE_TAKEN: "code", NAME_TAKEN: "name", UNIT_LOCKED: "unit" };

/** Wywołanie API JSON z obsługą błędów sieci i mapowaniem błędów pól (pierwszy komunikat na pole). */
export async function callApi(url: string, method: "POST" | "PATCH", body: unknown): Promise<ApiResult> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const json = (await res.json().catch(() => null)) as { data?: unknown } | null;
      return { ok: true, data: json?.data };
    }
    const json = (await res.json().catch(() => null)) as ErrorBody | null;
    const fields: Record<string, string> = {};
    for (const [key, messages] of Object.entries(json?.error?.fields ?? {})) {
      if (messages[0]) fields[key] = messages[0];
    }
    const message = json?.error?.message ?? `Błąd serwera (${res.status})`;
    const conflictField = json?.error?.code ? CONFLICT_FIELD[json.error.code] : undefined;
    if (conflictField) fields[conflictField] ??= message;
    return { ok: false, message, fields };
  } catch {
    return { ok: false, message: "Brak połączenia z serwerem", fields: {} };
  }
}

export type Notice = { kind: "ok" | "error"; text: string };

/**
 * Wykonuje akcję zapisu z blokadą podwójnego wysłania (ref + stan), komunikatem wyniku
 * i odświeżeniem danych strony po sukcesie. Zwraca wynik albo null, gdy inna akcja jest w toku.
 */
export function useApiAction() {
  const router = useRouter();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);

  async function run(request: () => Promise<ApiResult>, success: string): Promise<ApiResult | null> {
    if (lock.current) return null;
    lock.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const result = await request();
      if (result.ok) {
        setNotice({ kind: "ok", text: success });
        router.refresh();
      } else {
        setNotice({ kind: "error", text: result.message });
      }
      return result;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return { run, busy, notice, setNotice };
}

/** Pierwszy komunikat błędu na pole z wyniku zod.safeParse. */
export function zodFieldErrors(issues: readonly { path: readonly PropertyKey[]; message: string }[]) {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? "_");
    errors[key] ??= issue.message;
  }
  return errors;
}
