import { normalizeMaterialCode } from "@/lib/validation/catalog";
import type { ParsedLine } from "./types";

// Czyste funkcje normalizacji pozycji z pliku: sumowanie po kodzie, jednostki, zaokrąglanie.

/** Przycięcie tekstu do `max` znaków liczonych po code pointach (nie rozcina par zastępczych). */
export function cut(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

/** Ilość zaokrąglona do 3 miejsc (usuwa szum zmiennoprzecinkowy, np. 9.639999999999999 → 9.64). */
export function round3(value: number): number {
  return Number(value.toFixed(3));
}

/** Ilość do tekstu z przecinkiem dziesiętnym (do 3 miejsc, bez separatora tysięcy) — do odwołań i opisów. */
export function numberText(value: number): string {
  return String(round3(value)).replace(".", ",");
}

/**
 * Normalizacja jednostki do porównań: {m, mb, m.b., mb.} → „m”; {szt, szt., sztuk, sztuka} → „szt”;
 * inne → przycięte, małe litery.
 */
export function normalizeUnit(unit: string): string {
  const u = unit.trim().toLowerCase();
  if (u === "m" || u === "mb" || u === "m.b." || u === "mb.") return "m";
  if (u === "szt" || u === "szt." || u === "sztuk" || u === "sztuka") return "szt";
  return u;
}

/** Pozycja po zsumowaniu wierszy tego samego kodu. */
export type AggregatedItem = {
  /** Klucz = kod znormalizowany jak w bazie (trim, białe znaki → spacja, UPPERCASE). */
  key: string;
  /** Kod jak w pliku (pierwsze wystąpienie). */
  code: string;
  description: string;
  /** Suma ilości z pliku (zaokrąglona do 6 miejsc — bez szumu zmiennoprzecinkowego). */
  quantity: number;
  /** Jednostka z pliku (pierwsze wystąpienie). */
  unit: string;
  /** Różne jednostki tego samego kodu w pliku (po normalizacji) — więcej niż jedna to błąd pozycji. */
  fileUnits: string[];
  unitConflict: boolean;
  group: string | null;
  /** Profil tylko wtedy, gdy WSZYSTKIE wiersze kodu są w grupie „Profile…” (w razie wątpliwości importujemy). */
  isProfile: boolean;
  sourceRows: number[];
};

/** Sumuje wiersze po znormalizowanym kodzie; kolejność = pierwsze wystąpienie w pliku. */
export function aggregateLines(lines: readonly ParsedLine[]): AggregatedItem[] {
  const map = new Map<string, AggregatedItem>();
  for (const line of lines) {
    const key = normalizeMaterialCode(line.code);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        key,
        code: line.code,
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        fileUnits: [line.unit.trim()],
        unitConflict: false,
        group: line.group,
        isProfile: line.isProfile,
        sourceRows: [...line.sourceRows],
      });
      continue;
    }
    existing.quantity += line.quantity;
    if (existing.description === "" && line.description !== "") existing.description = line.description;
    if (!existing.fileUnits.some((u) => normalizeUnit(u) === normalizeUnit(line.unit))) {
      existing.fileUnits.push(line.unit.trim());
      existing.unitConflict = true;
    }
    existing.isProfile = existing.isProfile && line.isProfile;
    existing.sourceRows.push(...line.sourceRows);
  }
  const items = [...map.values()];
  for (const item of items) item.quantity = Number(item.quantity.toFixed(6));
  return items;
}
