import { describe, expect, it } from "vitest";
import { detectFormat, IMPORT_FORMATS, parseImport } from "@/modules/liczokno-import/formats";
import { LISTA_MATERIALOWA_ID } from "@/modules/liczokno-import/formats/lista-materialowa";
import { ImportParseError } from "@/modules/liczokno-import/types";

// Parser formatu „Lista materiałowa” LiczOkno na tablicach wierszy wzorowanych na prawdziwym pliku
// (dane zanonimizowane, bez cen klientów).

const TITLE = "Zlecenie: O_TP_2026_01_01_JAN_KOWALSKI_OFERTA         Utworzono: 03.10.2026";
const HEADER = ["Kod elementu", "Nr GM Systemowy", "Opis", "Ilość", "Jednostka miary", "Cena jedn. PLN", "Wartość PLN"];
const row = (code: string, desc: string, qty: unknown, unit: string | null): unknown[] => [code, code, desc, qty, unit, 1.5, 10];
const total = [null, null, null, null, null, "Razem:", 123.45];
const blank = [null, null, null, null, null, null, null];

function sample(): unknown[][] {
  return [
    [TITLE, null, null, null, null, null, null],
    HEADER,
    ["Akcesoria systemowe", null, null, null, null, null, null],
    row("A115", "Narożnik Montażowy 19,8x4,8", 32, "szt."),
    row("H208", "Izolator 64x44", 4.62, "m"),
    total,
    ["Okucia", null, null, null, null, null, null],
    row("K1102 10/AR-RAL7016-FS", "Listwa Szklenia 10", 7.4319999999999995, "m"),
    total,
    ["Profile niezespolone lakierowane ACS, AS, AF, ATF", null, null, null, null, null, null],
    row("P2102 30/10/AR-RAL7016-FS", "Ościeżnica Okienna 54", 0.5499999999999999, "m"),
    row("P2102 30/10/AR-RAL7016-FS", "Ościeżnica Okienna 54", 43.65, "m"),
    total,
    [null, null, null, null, null, "Razem wartość materiału bez rabatu:", 999.9],
    blank,
    ["GRUPA RABATOWA", "CENA BEZ RABATU", "RABAT %", "Cena z rabatem", null, null, null],
    ["Okucia", 100, 10, 90, null, null, null],
    ["RAZEM", 100, null, 90, null, null, null],
    blank,
    blank,
  ];
}

describe("format Lista materiałowa — parsowanie", () => {
  it("odczytuje nazwę zlecenia i datę z nagłówka", () => {
    const parsed = parseImport(sample());
    expect(parsed.formatId).toBe(LISTA_MATERIALOWA_ID);
    expect(parsed.orderNameHint).toBe("O_TP_2026_01_01_JAN_KOWALSKI_OFERTA");
    expect(parsed.documentDate).toBe("2026-10-03");
  });

  it("pomija grupy, wiersze „Razem”, puste i tabelę rabatów; zachowuje kolejność i numery wierszy", () => {
    const { lines } = parseImport(sample());
    expect(lines.map((l) => l.code)).toEqual([
      "A115",
      "H208",
      "K1102 10/AR-RAL7016-FS",
      "P2102 30/10/AR-RAL7016-FS",
      "P2102 30/10/AR-RAL7016-FS",
    ]);
    expect(lines.map((l) => l.sourceRows)).toEqual([[4], [5], [8], [11], [12]]);
    expect(lines[0]).toMatchObject({ description: "Narożnik Montażowy 19,8x4,8", quantity: 32, unit: "szt.", group: "Akcesoria systemowe" });
  });

  it("oznacza profile po nazwie grupy zaczynającej się od „Profile” (bez względu na wielkość liter)", () => {
    const { lines } = parseImport(sample());
    expect(lines.map((l) => l.isProfile)).toEqual([false, false, false, true, true]);
    const rows = sample();
    rows[9] = ["PROFILE zespolone", null, null, null, null, null, null];
    expect(parseImport(rows).lines[3].isProfile).toBe(true);
    rows[9] = ["Akcesoria profilowe", null, null, null, null, null, null];
    expect(parseImport(rows).lines[3].isProfile).toBe(false);
  });

  it("kolumny po nazwach nagłówków, nie po indeksach (inna kolejność, brak „Opis”)", () => {
    const rows: unknown[][] = [
      [TITLE],
      ["Jednostka miary", "Cena", "Ilość", "Kod elementu"],
      ["szt.", 1, 12, "A1"],
      ["m", 1, 3.5, "B2"],
    ];
    const { lines } = parseImport(rows);
    expect(lines).toMatchObject([
      { code: "A1", quantity: 12, unit: "szt.", description: "" },
      { code: "B2", quantity: 3.5, unit: "m" },
    ]);
  });

  it("nagłówek bywa niżej (do ~20 wierszy) i bez diakrytyków w nazwie kolumny", () => {
    const rows: unknown[][] = [...Array.from({ length: 8 }, () => [null]), [TITLE], ["Kod elementu", "Opis", "Ilosc", "Jednostka miary"], ["A1", "x", 2, "szt."]];
    const parsed = parseImport(rows);
    expect(parsed.lines[0].sourceRows).toEqual([11]);
    expect(parsed.orderNameHint).toBe("O_TP_2026_01_01_JAN_KOWALSKI_OFERTA");
  });

  it("ilość jako tekst z przecinkiem dziesiętnym (CSV), spacje ignorowane", () => {
    const rows = sample();
    rows[3] = row("A115", "x", "32", "szt.");
    rows[4] = row("H208", "x", " 4,62 ", "m");
    rows[7] = row("K1102 10/AR-RAL7016-FS", "x", "1 234,5", "m");
    const { lines } = parseImport(rows);
    expect(lines.slice(0, 3).map((l) => l.quantity)).toEqual([32, 4.62, 1234.5]);
  });

  it("wiersz z kodem bez poprawnej ilości → błąd z numerem wiersza (nie jest po cichu pomijany)", () => {
    for (const [qty, fragment] of [[null, "brak ilości"], ["abc", "nieprawidłowa ilość"], ["1,2,3", "nieprawidłowa ilość"], [0, "większa od zera"], [-2, "większa od zera"]] as const) {
      const rows = sample();
      rows[4] = row("H208", "x", qty, "m");
      expect(() => parseImport(rows), String(qty)).toThrow(ImportParseError);
      expect(() => parseImport(rows)).toThrow(/Wiersz 5/);
      expect(() => parseImport(rows)).toThrow(new RegExp(fragment));
    }
  });

  it("brak jednostki → błąd z numerem wiersza; ilość bez kodu → błąd", () => {
    const rows = sample();
    rows[3] = row("A115", "x", 3, null);
    expect(() => parseImport(rows)).toThrow(/Wiersz 4: brak jednostki/);
    const rows2 = sample();
    rows2[3] = [null, null, "x", 3, "szt.", null, null];
    expect(() => parseImport(rows2)).toThrow(/Wiersz 4: ilość bez kodu/);
  });

  it("wiersz z samym kodem (bez ilości i jednostki) to błąd z numerem wiersza, nazwa grupy — grupa", () => {
    const rows = sample();
    rows[3] = ["A115", null, null, null, null, null, null];
    expect(() => parseImport(rows)).toThrow(/Wiersz 4: brak ilości i jednostki dla kodu A115/);
    rows[3] = ["K1102 10/AR-RAL7016-FS", null, null, null, null, null, null];
    expect(() => parseImport(rows)).toThrow(/Wiersz 4: brak ilości i jednostki/);
    for (const name of ["Okucia", "Akcesoria Pozostałe PPoż", "Profile niezespolone lakierowane ACS, AS, AF, ATF"]) {
      const r = sample();
      r[2] = [name, null, null, null, null, null, null];
      expect(parseImport(r).lines[0].group).toBe(name);
    }
  });

  it("wiersze „Razem…” w kolumnie kodu są pomijane", () => {
    const rows = sample();
    rows.splice(5, 0, ["Razem:", null, null, null, null, null, 12], ["RAZEM wartość", null, null, null, null, null, 1], ["Razem wartość materiału bez rabatu:", null, null, 5, "szt.", null, null]);
    const { lines } = parseImport(rows);
    expect(lines).toHaveLength(5);
    expect(lines.some((l) => /razem/i.test(l.code))).toBe(false);
  });

  it("plik bez pozycji → błąd", () => {
    expect(() => parseImport([[TITLE], HEADER, ["Okucia"], total])).toThrow(/nie zawiera żadnych pozycji/);
  });

  it("bez wiersza „Zlecenie:” — brak podpowiedzi nazwy; nieparsowalna data → null", () => {
    const rows = sample();
    rows[0] = ["Lista", null];
    expect(parseImport(rows)).toMatchObject({ orderNameHint: null, documentDate: null });
    rows[0] = ["Zlecenie: ABC   Utworzono: 31.02.2026"];
    expect(parseImport(rows)).toMatchObject({ orderNameHint: "ABC", documentDate: null });
    rows[0] = ["Zlecenie: ABC"];
    expect(parseImport(rows)).toMatchObject({ orderNameHint: "ABC", documentDate: null });
  });
});

describe("wykrywanie formatu", () => {
  it("rozpoznaje Listę materiałową po nagłówku", () => {
    expect(detectFormat(sample())?.id).toBe(LISTA_MATERIALOWA_ID);
    expect(IMPORT_FORMATS.map((f) => f.id)).toContain(LISTA_MATERIALOWA_ID);
  });

  it("nieznany układ → czytelny błąd „Nieznany format pliku”", () => {
    const rows: unknown[][] = [["Imię", "Nazwisko"], ["Jan", "Kowalski"]];
    expect(detectFormat(rows)).toBeNull();
    expect(() => parseImport(rows)).toThrow(ImportParseError);
    expect(() => parseImport(rows)).toThrow(/Nieznany format pliku/);
    expect(() => parseImport([])).toThrow(/Nieznany format pliku/);
  });

  it("nagłówek poza pierwszymi 20 wierszami nie jest wykrywany", () => {
    const rows: unknown[][] = [...Array.from({ length: 25 }, () => [null]), HEADER, row("A1", "x", 1, "szt.")];
    expect(detectFormat(rows)).toBeNull();
  });
});
