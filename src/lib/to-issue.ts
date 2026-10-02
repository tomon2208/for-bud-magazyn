// „Do wydania na to zlecenie” (terminal): czysta logika podpowiedzi ilości.

export type ToIssueView = {
  /** ok — świeże dane z serwera; loading/error/none — brak podstaw do podpowiedzi. */
  kind: "ok" | "loading" | "error" | "none";
  items: { materialId: string; remaining: number }[];
};

/**
 * Podpowiedź ilości przy wydaniu: min(pozostało wg zapotrzebowania, dostępne w wybranej lokalizacji).
 * Tylko ze ŚWIEŻYCH danych (`kind === "ok"`) — stary wynik (sprzed ostatniego wydania) nie może zawyżać ilości.
 * Zwraca null, gdy nie ma podpowiedzi (materiał spoza zapotrzebowania, nic nie zostało, brak stanu).
 */
export function suggestIssueQuantity(view: ToIssueView, materialId: string, availableAtLocation: number): number | null {
  if (view.kind !== "ok") return null;
  const planned = view.items.find((i) => i.materialId === materialId);
  if (!planned || !(planned.remaining > 0) || !(availableAtLocation > 0)) return null;
  return Math.min(planned.remaining, availableAtLocation);
}
