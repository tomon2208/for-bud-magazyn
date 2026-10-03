import { cut } from "../normalize";
import { ImportParseError, type ImportFormat, type ParsedImport, type ParsedLine } from "../types";

// Format „Lista materiałowa” z LiczOkno (arkusz .xls/.xlsx/.csv):
//   w1: „Zlecenie: <nazwa>   Utworzono: <dd.mm.rrrr>”
//   nagłówek: Kod elementu | Nr GM Systemowy | Opis | Ilość | Jednostka miary | Cena jedn. | Wartość
//   grupy: wiersz z samym kodem w pierwszej kolumnie (np. „Okucia”, „Profile …”), potem pozycje, potem „Razem:”
//   na końcu: „Razem wartość materiału…” i tabela „GRUPA RABATOWA …” — pomijane.
// Kolumny wskazują NAZWY nagłówków (nie stałe indeksy); ceny i wartości są ignorowane.

export const LISTA_MATERIALOWA_ID = "liczokno-lista-materialowa";

const HEADER_SCAN_ROWS = 20;
const MAX_ROWS = 50_000;
/** Kod elementu: segmenty WIELKICH liter/cyfr/znaków . _ / - rozdzielone pojedynczą spacją (jak kod materiału). */
const CODE_LIKE = /^[A-Z0-9._/-]+( [A-Z0-9._/-]+)*$/;

/** Nazwa nagłówka do porównań: małe litery, bez polskich znaków i nadmiarowych spacji. */
function headerKey(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

type Columns = { code: number; description: number | null; quantity: number; unit: number };

function findHeader(rows: unknown[][]): { rowIndex: number; cols: Columns } | null {
  const limit = Math.min(rows.length, HEADER_SCAN_ROWS);
  for (let r = 0; r < limit; r++) {
    const keys = (rows[r] ?? []).map(headerKey);
    const code = keys.indexOf("kod elementu");
    const quantity = keys.indexOf("ilosc");
    const unit = keys.indexOf("jednostka miary");
    if (code === -1 || quantity === -1 || unit === -1) continue;
    const description = keys.indexOf("opis");
    return { rowIndex: r, cols: { code, description: description === -1 ? null : description, quantity, unit } };
  }
  return null;
}

/** „03.10.2026” → „2026-10-03” (null przy błędnej dacie). */
function isoDate(text: string): string | null {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(text.trim());
  if (!m) return null;
  const [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function readTitle(rows: unknown[][], headerIndex: number): { name: string | null; date: string | null } {
  for (let r = 0; r < headerIndex; r++) {
    for (const cell of rows[r] ?? []) {
      if (typeof cell !== "string" || !/zlecenie\s*:/i.test(cell)) continue;
      const m = /zlecenie\s*:\s*([\s\S]*?)\s*(?:utworzono\s*:\s*(\S+))?\s*$/i.exec(cell);
      if (!m) continue;
      const name = m[1].replace(/\s+/g, " ").trim();
      return { name: name === "" ? null : name, date: m[2] ? isoDate(m[2]) : null };
    }
  }
  return { name: null, date: null };
}

/** Ilość: liczba albo tekst z przecinkiem/kropką dziesiętną (spacje ignorowane). Zwraca null, gdy nie da się odczytać. */
function readQuantity(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.replace(/[\s  ]/g, "").replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(text) && !/^\.\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function isEmptyCell(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

function parse(rows: unknown[][]): ParsedImport {
  if (rows.length > MAX_ROWS) throw new ImportParseError(`Plik ma zbyt wiele wierszy (maksymalnie ${MAX_ROWS})`);
  const header = findHeader(rows);
  if (!header) throw new ImportParseError("Nieznany format pliku");
  const { cols } = header;
  const title = readTitle(rows, header.rowIndex);

  const lines: ParsedLine[] = [];
  let group: string | null = null;

  for (let i = header.rowIndex + 1; i < rows.length; i++) {
    const cells = rows[i] ?? [];
    const rowNo = i + 1;
    // Koniec listy: tabela rabatów.
    if (cells.some((c) => typeof c === "string" && /^\s*grupa rabatowa\b/i.test(c))) break;

    const code = cellText(cells[cols.code]);
    // Podsumowania („Razem:”, „Razem wartość…”) pomijamy bez względu na kolumnę, w której stoją.
    if (/^razem\b/i.test(code)) continue;
    if (code === "") {
      // Wiersze „Razem:”, puste i podsumowania pomijamy; ilość bez kodu to błąd (nie gubimy cicho pozycji).
      const hasText = cells.some((c) => typeof c === "string" && /razem/i.test(c));
      if (!hasText && !isEmptyCell(cells[cols.quantity])) {
        throw new ImportParseError(`Wiersz ${rowNo}: ilość bez kodu elementu`);
      }
      continue;
    }

    // Wiersz grupy: tylko nazwa w kolumnie kodu, reszta pusta. Jeśli „nazwa” wygląda jak kod elementu (wielkie litery,
    // cyfry, bez małych liter), to pozycja bez ilości i jednostki — błąd z numerem wiersza, nie cicha grupa.
    const onlyCode = cells.every((c, idx) => idx === cols.code || isEmptyCell(c));
    if (onlyCode) {
      if (CODE_LIKE.test(code)) throw new ImportParseError(`Wiersz ${rowNo}: brak ilości i jednostki dla kodu ${code}`);
      group = code;
      continue;
    }

    const quantity = readQuantity(cells[cols.quantity]);
    if (quantity === null) {
      const raw = cellText(cells[cols.quantity]);
      throw new ImportParseError(
        raw === ""
          ? `Wiersz ${rowNo}: brak ilości dla kodu ${code}`
          : `Wiersz ${rowNo}: nieprawidłowa ilość „${cut(raw, 30)}” dla kodu ${code}`,
      );
    }
    if (!(quantity > 0)) throw new ImportParseError(`Wiersz ${rowNo}: ilość dla kodu ${code} musi być większa od zera`);
    const unit = cellText(cells[cols.unit]);
    if (unit === "") throw new ImportParseError(`Wiersz ${rowNo}: brak jednostki miary dla kodu ${code}`);

    lines.push({
      code,
      description: cols.description === null ? "" : cellText(cells[cols.description]),
      quantity,
      unit,
      group,
      isProfile: group !== null && /^profile/i.test(group),
      sourceRows: [rowNo],
    });
  }

  if (lines.length === 0) throw new ImportParseError("Plik nie zawiera żadnych pozycji");
  return { formatId: LISTA_MATERIALOWA_ID, orderNameHint: title.name, documentDate: title.date, lines };
}

export const listaMaterialowa: ImportFormat = {
  id: LISTA_MATERIALOWA_ID,
  label: "LiczOkno — Lista materiałowa",
  detect: (rows) => findHeader(rows) !== null,
  parse,
};
