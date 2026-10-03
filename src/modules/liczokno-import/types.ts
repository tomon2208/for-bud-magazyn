// Import zapotrzebowania z LiczOkno (Etap 12a, ADR 016). Parser jest oddzielony od domeny magazynowej:
// specyfika konkretnego pliku (układ kolumn, nagłówki, grupy) kończy się na ParsedImport — dalej płyną
// wyłącznie znormalizowane pozycje. Nowy format = nowy plik w formats/ + wpis w rejestrze (formats/index.ts).

/** Pozycja odczytana z pliku — jeden wiersz źródła (sumowanie po kodzie robi normalize.ts). */
export type ParsedLine = {
  /** Kod elementu dokładnie jak w pliku (po przycięciu). */
  code: string;
  description: string;
  /** Ilość z pliku (liczba > 0, może zawierać szum zmiennoprzecinkowy). */
  quantity: number;
  /** Jednostka z pliku, np. „szt.”, „m”. */
  unit: string;
  /** Nazwa grupy, w której stoi wiersz (np. „Okucia”), albo null. */
  group: string | null;
  /** Pozycja z grupy „Profile…” — domyślnie pomijana (opcja „Szukaj też profili”). */
  isProfile: boolean;
  /** Numery wierszy arkusza (od 1). */
  sourceRows: number[];
};

export type ParsedImport = {
  formatId: string;
  /** Podpowiedź nazwy zlecenia z nagłówka pliku (do edycji przez użytkownika). */
  orderNameHint: string | null;
  /** Data dokumentu (YYYY-MM-DD) z nagłówka pliku. */
  documentDate: string | null;
  lines: ParsedLine[];
};

export type ImportFormat = {
  /** Trafia do requirements.import_format. */
  id: string;
  label: string;
  /** Czy to ten układ pliku (po zawartości, nie po nazwie). */
  detect: (rows: unknown[][]) => boolean;
  /** Rzuca ImportParseError przy błędnych danych (z numerem wiersza). */
  parse: (rows: unknown[][]) => ParsedImport;
};

/** Błąd odczytu/parsowania pliku — komunikat jest czytelny dla użytkownika. */
export class ImportParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportParseError";
  }
}
