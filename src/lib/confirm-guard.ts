import { useRef } from "react";

// Ochrona przycisku potwierdzenia przed podwójnym kliknięciem (review Etapu 6, M1): gdy po „Dalej” w tym samym
// miejscu pojawia się „Zatwierdź”, drugie kliknięcie dwukliku trafiłoby w nowy przycisk i wykonało operację.
// Kliknięcie potwierdzenia jest ignorowane, gdy jest częścią wielokrotnego kliknięcia (event.detail > 1) albo nastąpiło
// mniej niż CONFIRM_ARM_MS od wejścia w stan potwierdzenia. Klawiatura (Enter/Spacja: detail = 0) działa normalnie.

export const CONFIRM_ARM_MS = 400;

/** Czysta decyzja (testy jednostkowe). */
export function confirmClickAllowed(armedAt: number, now: number, detail: number, ms = CONFIRM_ARM_MS): boolean {
  return detail <= 1 && now - armedAt >= ms;
}

/** `arm()` — wywołaj przy wejściu w stan potwierdzenia; `allow(event)` — w handlerze przycisku potwierdzenia. */
export function useConfirmGuard() {
  const armedAt = useRef(0);
  return {
    arm: () => {
      armedAt.current = Date.now();
    },
    allow: (event: { detail: number }) => confirmClickAllowed(armedAt.current, Date.now(), event.detail),
  };
}
