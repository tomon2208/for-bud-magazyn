import type { CountingItemDto } from "@/server/inventory";
import { checkQuantity, formatQuantity } from "./validation/stock";

// Ekran liczenia lokalizacji na terminalu (Etap 13, ADR 015) — czysta logika (testy jednostkowe).
// Liczenie „na ślepo”: wiersze NIE zawierają stanu systemowego (DTO go nie ma). Pole puste = pozycja nie zostanie
// wysłana: materiał oczekiwany zostaje „niepoliczony” (nie zerujemy automatycznie), a wcześniejsze liczenie tej
// pozycji jest usuwane — dlatego przed zapisem pokazujemy listę pustych pozycji do potwierdzenia.

export type CountRow = {
  materialId: string;
  code: string;
  name: string;
  unit: string;
  allowsFraction: boolean;
  active: boolean;
  /** System oczekuje materiału w lokalizacji (bez ilości). */
  expected: boolean;
  /** Dodany przez liczącego („Dodaj inny materiał”) w tym ekranie. */
  added: boolean;
  state: CountingItemDto["state"];
  /** Wcześniej zapisane liczenie (dowolnego liczącego) — null = brak. */
  previous: number | null;
  /** Treść pola ilości (przecinek dziesiętny). */
  text: string;
};

/**
 * Wiersze startowe: zapisane liczenie COUNTED → wpisane w pole (ponowne liczenie je nadpisze); RECOUNT → pole puste
 * (ruch po liczeniu — policz od nowa); APPROVED → tylko do odczytu.
 */
export function initialRows(items: CountingItemDto[]): CountRow[] {
  return items.map((i) => ({
    materialId: i.materialId,
    code: i.code,
    name: i.name,
    unit: i.unit,
    allowsFraction: i.allowsFraction,
    active: i.active,
    expected: i.expected,
    added: false,
    state: i.state,
    previous: i.countedQuantity,
    text: i.state === "COUNTED" || i.state === "APPROVED" ? (i.countedQuantity === null ? "" : formatQuantity(i.countedQuantity)) : "",
  }));
}

export function addRow(
  rows: CountRow[],
  m: { id: string; code: string; name: string; unit: string; allowsFraction: boolean; active?: boolean },
): { rows: CountRow[]; existed: boolean } {
  if (rows.some((r) => r.materialId === m.id)) return { rows, existed: true };
  return {
    existed: false,
    rows: [
      ...rows,
      {
        materialId: m.id,
        code: m.code,
        name: m.name,
        unit: m.unit,
        allowsFraction: m.allowsFraction,
        active: m.active !== false,
        expected: false,
        added: true,
        state: null,
        previous: null,
        text: "",
      },
    ],
  };
}

export type BuildCountResult =
  | {
      ok: true;
      items: { material_id: string; quantity: number }[];
      /** Puste pola materiałów oczekiwanych bez wcześniejszego liczenia — zostaną niepoliczone. */
      uncounted: CountRow[];
      /** Puste pola pozycji, które miały liczenie — liczenie zostanie usunięte. */
      removed: CountRow[];
    }
  | { ok: false; errors: Record<string, string> };

/** Pozycje do wysłania (zatwierdzone pomijamy — baza ich nie zmienia) albo błędy pól (klucz = materialId). */
export function buildCountItems(rows: CountRow[]): BuildCountResult {
  const errors: Record<string, string> = {};
  const items: { material_id: string; quantity: number }[] = [];
  const uncounted: CountRow[] = [];
  const removed: CountRow[] = [];
  for (const r of rows) {
    if (r.state === "APPROVED") continue;
    if (r.text.trim() === "") {
      if (r.previous !== null) removed.push(r);
      else if (r.expected) uncounted.push(r);
      continue;
    }
    const q = checkQuantity(r.text, r.allowsFraction, { allowZero: true });
    if (!q.ok) errors[r.materialId] = q.message;
    else items.push({ material_id: r.materialId, quantity: q.value });
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, items, uncounted, removed };
}
