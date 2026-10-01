"use client";

import { useRef, useState } from "react";
import {
  canEdit,
  discardAttempt,
  finishSend,
  initialAttempt,
  isUnresolved,
  startSend,
  type Attempt,
} from "./operation-attempt";
import type { SubmitResult } from "./stock-client";

/**
 * Formularz operacji magazynowej na desktopie (przyjęcie / wydanie / przesunięcie) — stan próby z
 * operation-attempt: po wyniku nieznanym albo 401 dane zamrożone, ponowienie wysyła DOKŁADNIE zapamiętany
 * payload z tym samym client_request_id; w trakcie wysyłania kolejne wysłanie jest ignorowane.
 */
export function useOperationAttempt<P extends { client_request_id: string }>() {
  const [attempt, setAttempt] = useState<Attempt<P>>(initialAttempt);
  const ref = useRef(attempt); // bieżący stan dla handlera (blokada podwójnego kliknięcia)
  const set = (a: Attempt<P>) => {
    ref.current = a;
    setAttempt(a);
  };

  /**
   * Wysyła nowe dane (`payload`, gdy próba jest „idle”) albo ponawia zapamiętane żądanie (gdy wynik był
   * nieznany — `payload` jest wtedy ignorowany). Zwraca null, gdy nic nie wysłano (wysyłanie w toku).
   */
  async function run<R>(payload: P | null, submit: (body: P) => Promise<SubmitResult<R>>): Promise<SubmitResult<R> | null> {
    const current = ref.current;
    const p = isUnresolved(current) ? current.payload : payload;
    if (!p) return null;
    const started = startSend(current, p, () => crypto.randomUUID());
    if (!started) return null;
    const body = { ...started.payload, client_request_id: started.requestId };
    const sending: Attempt<P> = { ...started.next, payload: body };
    set(sending);
    const res = await submit(body);
    set(finishSend(sending, res.kind));
    return res;
  }

  return {
    attempt,
    /** Stan aktualny w chwili wywołania (nie z ostatniego renderu). */
    current: () => ref.current,
    run,
    discard: () => set(discardAttempt<P>()),
    locked: !canEdit(attempt),
    unresolved: isUnresolved(attempt),
    sending: attempt.status === "sending",
  };
}
