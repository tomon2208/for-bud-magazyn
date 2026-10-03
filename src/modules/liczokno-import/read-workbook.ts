import { ImportParseError } from "./types";

// Odczyt pliku (.xls / .xlsx / .csv) → pierwszy arkusz jako tablica wierszy. To JEDYNE miejsce, które zna SheetJS.
// Wywoływane WYŁĄCZNIE w przeglądarce (komponent importu): biblioteka jest ładowana dynamicznym import() i nie
// trafia do bundla Workera (limit CPU 10 ms i rozmiaru 3 MiB — PLAN, sekcja 0). Do serwera idzie tylko JSON.

export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
export const ACCEPTED_IMPORT_EXTENSIONS = [".xls", ".xlsx", ".csv"] as const;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

/** CSV z Excela bywa w UTF-8 albo Windows-1250 — próbujemy UTF-8 (ścisłe), potem Windows-1250. */
function decodeCsv(buffer: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder("windows-1250").decode(buffer);
  }
}

/**
 * Separator CSV wykrywany z wiersza nagłówka („Kod elementu”): liczymy ; TAB , poza cudzysłowami i wybieramy
 * najczęstszy (remis: średnik). Wiersz tytułowy bywa pełen przecinków („Zlecenie: A, B”), więc nie liczymy go.
 * Bez wiersza nagłówka — pierwszy niepusty wiersz.
 */
export function detectCsvSeparator(text: string): string {
  const lines = text.split(/\r\n|\n|\r/);
  const header = lines.slice(0, 20).find((l) => /kod elementu/i.test(l)) ?? lines.find((l) => l.trim() !== "") ?? "";
  const counts: Record<string, number> = { ";": 0, "\t": 0, ",": 0 };
  let quoted = false;
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch in counts) counts[ch]++;
  }
  let best = ";";
  for (const sep of [";", "\t", ","]) if (counts[sep] > counts[best]) best = sep;
  return best;
}

/** Usuwa puste wiersze z końca (BIFF często raportuje tysiąc pustych wierszy). */
function trimTrailingEmptyRows(rows: unknown[][]): unknown[][] {
  let end = rows.length;
  while (end > 0 && (rows[end - 1] ?? []).every((c) => c === null || c === undefined || (typeof c === "string" && c.trim() === ""))) {
    end--;
  }
  return rows.slice(0, end);
}

export async function readWorkbookRows(file: File): Promise<unknown[][]> {
  const ext = extensionOf(file.name);
  if (!(ACCEPTED_IMPORT_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new ImportParseError("Obsługiwane pliki: .xls, .xlsx, .csv");
  }
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    throw new ImportParseError("Plik jest za duży (maksymalnie 5 MB)");
  }
  if (file.size === 0) throw new ImportParseError("Plik jest pusty");

  const XLSX = await import("xlsx");
  const buffer = await file.arrayBuffer();
  let workbook;
  try {
    // raw: tekst CSV zostaje tekstem (przecinek dziesiętny „7,432” nie zamieni się w 7432) — liczby czyta parser formatu.
    if (ext === ".csv") {
      const text = decodeCsv(buffer);
      workbook = XLSX.read(text, { type: "string", raw: true, FS: detectCsvSeparator(text) });
    } else {
      workbook = XLSX.read(buffer, { type: "array" });
    }
  } catch {
    throw new ImportParseError("Nie udało się odczytać pliku — czy to na pewno arkusz Excel lub CSV?");
  }
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new ImportParseError("Plik nie zawiera arkuszy");
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: true, blankrows: true, range: 0 });
  return trimTrailingEmptyRows(rows);
}
