// „Do wydania na to zlecenie” (terminal): czysta logika podpowiedzi ilości.

export type ToIssueView = {
  /** ok — świeże dane z serwera; loading/error/none — brak podstaw do podpowiedzi. */
  kind: "ok" | "loading" | "error" | "none";
  /** available (Etap 11) — ile można wydać na to zlecenie łącznie: wolne + rezerwacja zlecenia. */
  items: { materialId: string; remaining: number; available?: number }[];
};

/**
 * Podpowiedź ilości przy wydaniu: min(pozostało wg zapotrzebowania, dostępne w wybranej lokalizacji, dostępne dla
 * zlecenia z rezerwacjami). Tylko ze ŚWIEŻYCH danych (`kind === "ok"`) — stary wynik (sprzed ostatniego wydania) nie
 * może zawyżać ilości. Zwraca null, gdy nie ma podpowiedzi (materiał spoza zapotrzebowania, nic nie zostało, brak
 * stanu albo całość zarezerwowana dla innych zleceń).
 */
export function suggestIssueQuantity(view: ToIssueView, materialId: string, availableAtLocation: number): number | null {
  if (view.kind !== "ok") return null;
  const planned = view.items.find((i) => i.materialId === materialId);
  if (!planned || !(planned.remaining > 0) || !(availableAtLocation > 0)) return null;
  const forOrder = planned.available ?? Number.POSITIVE_INFINITY;
  if (!(forOrder > 0)) return null;
  return Math.min(planned.remaining, availableAtLocation, forOrder);
}

/** Etap 11: ile można wydać z tej lokalizacji z uwzględnieniem rezerwacji (null — dostępność nieznana). */
export function issueLimit(availableAtLocation: number, availableForIssue: number | null): number {
  return availableForIssue === null ? availableAtLocation : Math.max(0, Math.min(availableAtLocation, availableForIssue));
}
