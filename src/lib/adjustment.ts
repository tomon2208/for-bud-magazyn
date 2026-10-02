import { checkQuantity, formatQuantity } from "./validation/stock";

// Korekta „ustaw stan na X” — czysta logika podglądu różnicy (desktop i terminal; testy jednostkowe).

export type AdjustmentPreview =
  | { kind: "empty" }
  | { kind: "invalid"; message: string }
  | { kind: "same"; target: number }
  | { kind: "diff"; target: number; delta: number; label: string };

/** Różnica w tysięcznych (bez błędów zmiennoprzecinkowych typu 0,1 + 0,2). */
export function quantityDelta(target: number, current: number): number {
  return Math.round(target * 1000 - current * 1000) / 1000;
}

/** „+3 szt.” / „−2,5 mb” (znak minus typograficzny). */
export function formatDelta(delta: number, unit: string): string {
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
  return `${sign}${formatQuantity(Math.abs(delta))} ${unit}`;
}

/**
 * Podgląd na żywo: faktyczna ilość z pola (≥ 0, przecinek, skala 3, całkowita gdy !allowsFraction) vs stan,
 * który ADMIN widzi. "same" — stan się zgadza, korekta niepotrzebna (nie wysyłamy).
 */
export function previewAdjustment(raw: string, current: number, unit: string, allowsFraction: boolean): AdjustmentPreview {
  if (raw.trim() === "") return { kind: "empty" };
  const q = checkQuantity(raw, allowsFraction, { allowZero: true });
  if (!q.ok) return { kind: "invalid", message: q.message };
  const delta = quantityDelta(q.value, current);
  if (delta === 0) return { kind: "same", target: q.value };
  return { kind: "diff", target: q.value, delta, label: formatDelta(delta, unit) };
}

/**
 * Review Etapu 11 (L6): o ile suma rezerwacji przekroczy stan materiału (aktywne lokalizacje) po korekcie o `delta`.
 * 0 — brak problemu (korekta w górę, brak danych o rezerwacjach). Lokalizacja nieaktywna nie liczy się do stanu.
 */
export function reservationShortfallAfterAdjust(
  avail: { stockActive: number; reservedTotal: number } | null,
  delta: number,
  locationActive: boolean,
): number {
  if (!avail || !(delta < 0) || avail.reservedTotal <= 0) return 0;
  const after = avail.stockActive + (locationActive ? delta : 0);
  return Math.max(0, Math.round((avail.reservedTotal - after) * 1000) / 1000);
}
