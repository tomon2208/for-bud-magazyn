import { ImportParseError, type ImportFormat, type ParsedImport } from "../types";
import { listaMaterialowa } from "./lista-materialowa";

// Rejestr formatów plików. Nowy format LiczOkno = nowy plik w tym katalogu + wpis poniżej
// (detect() powinno być jednoznaczne — pierwszy pasujący format wygrywa).
export const IMPORT_FORMATS: readonly ImportFormat[] = [listaMaterialowa];

export function detectFormat(rows: unknown[][]): ImportFormat | null {
  return IMPORT_FORMATS.find((f) => f.detect(rows)) ?? null;
}

/** Wykrywa format i parsuje arkusz; brak dopasowania → czytelny błąd. */
export function parseImport(rows: unknown[][]): ParsedImport {
  const format = detectFormat(rows);
  if (!format) {
    throw new ImportParseError(
      "Nieznany format pliku. Obsługiwane: " + IMPORT_FORMATS.map((f) => f.label).join(", ") + ".",
    );
  }
  return format.parse(rows);
}

export function formatLabel(formatId: string): string {
  return IMPORT_FORMATS.find((f) => f.id === formatId)?.label ?? formatId;
}
