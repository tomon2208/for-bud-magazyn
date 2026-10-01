"use client";

import { useEffect, useRef, useState } from "react";
import { clearPending, savePending, usePendingOperation, type PendingOperation } from "@/lib/pending-operation";
import { submitOperation, type OperationKind, type ResponseOf } from "@/lib/stock-client";

/**
 * network — wynik nieznany (sieć / 5xx / RETRY) → ponów TEN SAM id; auth — sesja wygasła, operacja niewykonana,
 * ale zachowana do dokończenia po zalogowaniu; domain — serwer odrzucił → popraw dane (nowy id).
 */
export type SubmitError = {
  kind: "network" | "auth" | "domain";
  message: string;
  code?: string;
  /** INSUFFICIENT_STOCK: dostępna ilość w lokalizacji wg serwera. */
  available?: number;
};

/**
 * Wysyłanie operacji magazynowej z terminala — wspólne dla przyjęcia, wydania i przesunięcia (ADR 009 M4,
 * ADR 010). Zapis w sessionStorage od wysłania do jednoznacznego wyniku; blokada podwójnego tapnięcia;
 * ostrzeżenie `beforeunload`, gdy wynik nieznany albo trwa wysyłanie; ekran dokończenia (`showResume`), gdy
 * w storage jest niepotwierdzona operacja, która nie powstała w tym ekranie (odświeżenie, powrót, logowanie).
 */
export function useOperationSubmit<K extends OperationKind>(kind: K, userId: string) {
  const pending = usePendingOperation(kind, userId);
  const [ownRequestId, setOwnRequestId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<SubmitError | null>(null);
  const lock = useRef(false); // blokada podwójnego tapnięcia (niezależna od cyklu renderowania)

  // Po błędzie sieci / wygaśnięciu sesji nie pozwalamy zmieniać danych bez ponowienia albo jawnego porzucenia.
  const unresolved = error?.kind === "network" || error?.kind === "auth";
  const showResume = pending !== null && pending.requestId !== ownRequestId;

  useEffect(() => {
    if (!unresolved && !submitting) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ""; // starsze przeglądarki
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unresolved, submitting]);

  /**
   * Wysyła (albo ponawia) DOKŁADNIE zapisane żądanie. Zwraca dane przy sukcesie, inaczej null (błąd w `error`).
   * `onDomainError` — reakcja kreatora na odrzucenie przez serwer (np. aktualna dostępność przy INSUFFICIENT_STOCK);
   * zwraca błąd do pokazania (np. z komunikatem uzupełnionym o jednostkę).
   */
  async function send(
    p: PendingOperation<K>,
    onDomainError?: (e: SubmitError) => SubmitError,
  ): Promise<ResponseOf<K> | null> {
    if (lock.current) return null;
    lock.current = true;
    setSubmitting(true);
    setError(null);
    setOwnRequestId(p.requestId);
    savePending(p);
    try {
      const res = await submitOperation(kind, p.payload);
      if (res.kind === "ok") {
        clearPending(kind);
        return res.data;
      }
      if (res.kind === "network" || res.kind === "auth") {
        setError({ kind: res.kind, message: res.message });
      } else {
        clearPending(kind); // serwer jednoznacznie odrzucił — nic nie zapisano
        const err: SubmitError = { kind: "domain", message: res.message, code: res.code, available: res.available };
        setError(onDomainError ? onDomainError(err) : err);
      }
      return null;
    } finally {
      lock.current = false;
      setSubmitting(false);
    }
  }

  /** Jawne porzucenie niepotwierdzonej operacji (po potwierdzeniu). Zwraca true, gdy porzucono. */
  function discard(question: string): boolean {
    if (!window.confirm(question)) return false;
    clearPending(kind);
    setError(null);
    setOwnRequestId(null);
    return true;
  }

  return {
    pending,
    showResume,
    submitting,
    error,
    unresolved,
    /** Dane można edytować (nic nie jest w toku ani niepotwierdzone). */
    locked: unresolved || submitting,
    send,
    discard,
    clearError: () => setError(null),
  };
}
