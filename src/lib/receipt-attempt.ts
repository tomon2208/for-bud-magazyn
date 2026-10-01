// Cykl życia jednej próby zapisu operacji magazynowej (czysta logika, testowana jednostkowo).
// Zasady (ADR 009, M1):
// * nowy client_request_id tylko dla NOWYCH danych (status "idle"),
// * po wyniku nieznanym ("unknown": błąd sieci / 5xx / RETRY) albo wygaśnięciu sesji ("auth") dane są
//   zamrożone — jedyne akcje: ponowienie TEGO SAMEGO żądania (ten sam id i payload) albo jawne porzucenie,
// * w trakcie wysyłania ("sending") kolejne wysłanie jest ignorowane (podwójne kliknięcie).

export type AttemptStatus = "idle" | "sending" | "unknown" | "auth";

export type Attempt<P> = {
  status: AttemptStatus;
  requestId: string | null;
  payload: P | null;
  /** Status sprzed wysyłania — żeby po wyniku wiedzieć, czy to było ponowienie. */
  retry: boolean;
};

export type AttemptResultKind = "ok" | "network" | "auth" | "error";

export const initialAttempt = <P>(): Attempt<P> => ({ status: "idle", requestId: null, payload: null, retry: false });

/** Czy pola formularza można edytować. */
export const canEdit = (a: Attempt<unknown>) => a.status === "idle";

/** Czy wynik poprzedniej próby jest nieznany / niedokończony (wymaga ponowienia albo porzucenia). */
export const isUnresolved = (a: Attempt<unknown>) => a.status === "unknown" || a.status === "auth";

/**
 * Rozpoczęcie wysyłania. Dla "idle" — nowy id i bieżący payload; dla "unknown"/"auth" — DOKŁADNIE poprzednie
 * żądanie (payload z argumentu jest ignorowany). "sending" → null (ignoruj).
 */
export function startSend<P>(
  a: Attempt<P>,
  payload: P,
  makeId: () => string,
): { next: Attempt<P>; requestId: string; payload: P } | null {
  if (a.status === "sending") return null;
  if (isUnresolved(a) && a.requestId && a.payload !== null) {
    return {
      next: { ...a, status: "sending", retry: true },
      requestId: a.requestId,
      payload: a.payload,
    };
  }
  const requestId = makeId();
  return {
    next: { status: "sending", requestId, payload, retry: false },
    requestId,
    payload,
  };
}

/** Wynik wysyłania. ok / błąd domenowy → koniec próby (nowe dane = nowy id); sieć / sesja → zamrożenie. */
export function finishSend<P>(a: Attempt<P>, kind: AttemptResultKind): Attempt<P> {
  if (kind === "network") return { ...a, status: "unknown" };
  if (kind === "auth") return { ...a, status: "auth" };
  return initialAttempt<P>();
}

/** Jawne porzucenie niepotwierdzonej próby (użytkownik sprawdzi wynik na liście). */
export const discardAttempt = <P>(): Attempt<P> => initialAttempt<P>();
