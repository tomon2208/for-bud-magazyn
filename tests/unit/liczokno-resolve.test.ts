import { describe, expect, it } from "vitest";
import { aggregateLines, normalizeUnit, numberText, round3 } from "@/modules/liczokno-import/normalize";
import {
  buildImportItems,
  buildPreview,
  buildRawSourceRef,
  summarizePreview,
  type CodeResolution,
  type ItemOverride,
  type ResolvedMaterial,
} from "@/modules/liczokno-import/resolve";
import type { ParsedLine } from "@/modules/liczokno-import/types";

const line = (code: string, quantity: number, unit: string, row: number, extra: Partial<ParsedLine> = {}): ParsedLine => ({
  code,
  description: `Opis ${code}`,
  quantity,
  unit,
  group: "Okucia",
  isProfile: false,
  sourceRows: [row],
  ...extra,
});

const mat = (code: string, unit: string, extra: Partial<ResolvedMaterial> = {}): ResolvedMaterial => ({
  id: `id-${code}`,
  code,
  name: `Materiał ${code}`,
  unit,
  allowsFraction: !["szt.", "szt", "sztanga"].includes(unit),
  barLengthM: null,
  active: true,
  ...extra,
});

const res = (material: ResolvedMaterial | null, status: CodeResolution["status"] = "MATERIAL"): CodeResolution => ({
  code: material?.code ?? "",
  status,
  aliasId: null,
  material,
});

function preview(lines: ParsedLine[], resolutions: Record<string, CodeResolution>, opts = { includeProfiles: false }, overrides: Record<string, ItemOverride> = {}) {
  return buildPreview(aggregateLines(lines), new Map(Object.entries(resolutions)), opts, new Map(Object.entries(overrides)));
}

describe("jednostki", () => {
  it("normalizacja: m / mb / m.b. / mb. → m; szt / szt. / sztuk / sztuka → szt; inne po trim+lowercase", () => {
    for (const u of ["m", "M", " mb ", "m.b.", "MB."]) expect(normalizeUnit(u)).toBe("m");
    for (const u of ["szt", "szt.", "Sztuk", " sztuka "]) expect(normalizeUnit(u)).toBe("szt");
    expect(normalizeUnit(" Opak. ")).toBe("opak.");
    expect(normalizeUnit("sztanga")).toBe("sztanga");
  });

  it("zaokrąglanie usuwa szum float", () => {
    expect(round3(9.639999999999999)).toBe(9.64);
    expect(numberText(0.5499999999999999)).toBe("0,55");
    expect(numberText(44.2)).toBe("44,2");
  });
});

describe("sumowanie po kodzie", () => {
  it("sumuje wiersze tego samego kodu (po normalizacji), kasuje szum, zachowuje numery wierszy i kolejność", () => {
    const items = aggregateLines([
      line("P2102 30/10", 0.5499999999999999, "m", 123),
      line("A1", 4, "szt.", 124),
      line("p2102  30/10", 43.65, "m", 125),
    ]);
    expect(items.map((i) => i.key)).toEqual(["P2102 30/10", "A1"]);
    expect(items[0]).toMatchObject({ quantity: 44.2, sourceRows: [123, 125], code: "P2102 30/10", unitConflict: false });
  });

  it("ten sam kod z różnymi jednostkami → konflikt jednostek", () => {
    const [item] = aggregateLines([line("A1", 1, "m", 1), line("A1", 2, "szt.", 2)]);
    expect(item.unitConflict).toBe(true);
    expect(item.fileUnits).toEqual(["m", "szt."]);
    // „m” i „mb” to ta sama jednostka
    expect(aggregateLines([line("A1", 1, "m", 1), line("A1", 2, "mb", 2)])[0].unitConflict).toBe(false);
  });

  it("profil tylko, gdy wszystkie wiersze kodu są profilami", () => {
    expect(aggregateLines([line("P1", 1, "m", 1, { isProfile: true }), line("P1", 1, "m", 2, { isProfile: true })])[0].isProfile).toBe(true);
    expect(aggregateLines([line("P1", 1, "m", 1, { isProfile: true }), line("P1", 1, "m", 2)])[0].isProfile).toBe(false);
  });
});

describe("podgląd importu — statusy", () => {
  it("OK: ta sama jednostka, ilość zaokrąglona (szum float)", () => {
    const [p] = preview([line("H208", 9.639999999999999, "m", 5)], { H208: res(mat("H208", "mb")) });
    expect(p).toMatchObject({ status: "OK", quantity: 9.64, ready: true, conversion: null });
  });

  it("PRZELICZONO: m → sztangi, ceil(suma / długość) z podglądem „44,2 m → 7 szt.”", () => {
    const [p] = preview(
      [line("P2102", 0.55, "m", 1), line("P2102", 43.65, "m", 2)],
      { P2102: res(mat("P2102", "szt.", { barLengthM: 6.5 })) },
    );
    expect(p).toMatchObject({ status: "PRZELICZONO", quantity: 7, ready: true, conversion: "44,2 m → 7 szt." });
  });

  it("tolerancja przy zaokrąglaniu w górę: 13,0 / 6,5 = 2 (nie 3), 13,001 / 6,5 = 3", () => {
    const resolutions = { P1: res(mat("P1", "szt.", { barLengthM: 6.5 })) };
    expect(preview([line("P1", 13, "m", 1)], resolutions)[0].quantity).toBe(2);
    expect(preview([line("P1", 12.999999999999998, "m", 1)], resolutions)[0].quantity).toBe(2);
    expect(preview([line("P1", 13.001, "m", 1)], resolutions)[0].quantity).toBe(3);
    expect(preview([line("P1", 0.01, "m", 1)], resolutions)[0].quantity).toBe(1);
  });

  it("BLAD_JEDNOSTKI: niezgodne jednostki bez długości sztangi, komunikat z jednostkami", () => {
    const [p] = preview([line("P1", 10, "m", 1)], { P1: res(mat("P1", "szt.")) });
    expect(p).toMatchObject({ status: "BLAD_JEDNOSTKI", quantity: null, ready: false });
    expect(p.message).toBe("Niezgodna jednostka (plik: m, kartoteka: szt.)");
    // pliki w szt., kartoteka w mb — też błąd (przeliczamy wyłącznie m → sztangi)
    expect(preview([line("P1", 10, "szt.", 1)], { P1: res(mat("P1", "mb", { barLengthM: 6 })) })[0].status).toBe("BLAD_JEDNOSTKI");
  });

  it("BLAD_JEDNOSTKI: ten sam kod z różnymi jednostkami w pliku", () => {
    const [p] = preview([line("A1", 1, "m", 1), line("A1", 2, "szt.", 2)], { A1: res(mat("A1", "szt.")) });
    expect(p.status).toBe("BLAD_JEDNOSTKI");
    expect(p.message).toMatch(/różne jednostki/);
  });

  it("NIE_CALKOWITA: ułamek dla materiału bez ułamków", () => {
    const [p] = preview([line("A1", 2.5, "szt.", 1)], { A1: res(mat("A1", "szt.")) });
    expect(p).toMatchObject({ status: "NIE_CALKOWITA", ready: false, quantity: null });
  });

  it("NIEAKTYWNY, NIEZNANY", () => {
    const rows = preview(
      [line("A1", 1, "szt.", 1), line("B1", 1, "szt.", 2), line("C1", 1, "szt.", 3)],
      { A1: res(mat("A1", "szt.", { active: false })), B1: res(null, "UNKNOWN") },
    );
    expect(rows.map((r) => r.status)).toEqual(["NIEAKTYWNY", "NIEZNANY", "NIEZNANY"]);
  });

  it("NIE_MAGAZYNUJEMY: kod z listy ignorowanych (nawet gdy istnieje w kartotece)", () => {
    const [p] = preview([line("A1", 1, "szt.", 1)], { A1: { code: "A1", status: "IGNORED", aliasId: "x", material: null } });
    expect(p).toMatchObject({ status: "NIE_MAGAZYNUJEMY", ready: false });
  });

  it("PROFIL_POMINIETY gdy opcja wyłączona; włączona → normalne przeliczenie", () => {
    const lines = [line("P1", 13, "m", 1, { isProfile: true, group: "Profile zespolone" })];
    const resolutions = { P1: res(mat("P1", "szt.", { barLengthM: 6.5 })) };
    expect(preview(lines, resolutions, { includeProfiles: false })[0]).toMatchObject({ status: "PROFIL_POMINIETY", ready: false });
    expect(preview(lines, resolutions, { includeProfiles: true })[0]).toMatchObject({ status: "PRZELICZONO", quantity: 2, ready: true });
  });

  it("POMINIETY_RECZNIE; wskazany materiał (override) zastępuje dopasowanie", () => {
    const resolutions = { A1: res(null, "UNKNOWN") };
    const lines = [line("A1", 3, "szt.", 1)];
    expect(preview(lines, resolutions, undefined, { A1: { skip: true } })[0].status).toBe("POMINIETY_RECZNIE");
    const picked = preview(lines, resolutions, undefined, { A1: { material: mat("X9", "szt.") } })[0];
    expect(picked).toMatchObject({ status: "OK", quantity: 3, ready: true });
    expect(picked.material?.code).toBe("X9");
  });

  it("ręczna ilość odblokowuje pozycję z błędem jednostki; błędna ręczna ilość → BLAD_ILOSCI", () => {
    const resolutions = { P1: res(mat("P1", "szt.")) };
    const lines = [line("P1", 10, "m", 1)];
    const ok = preview(lines, resolutions, undefined, { P1: { quantityText: "2" } })[0];
    expect(ok).toMatchObject({ status: "RECZNIE", quantity: 2, ready: true, manual: true });
    const comma = preview([line("H1", 1, "m", 1)], { H1: res(mat("H1", "mb")) }, undefined, { H1: { quantityText: "2,5" } })[0];
    expect(comma.quantity).toBe(2.5);
    for (const text of ["0", "-1", "1,0001", "abc", "2,5"]) {
      const bad = preview(lines, resolutions, undefined, { P1: { quantityText: text } })[0];
      expect(bad.ready, text).toBe(false);
      expect(bad.status, text).toBe("BLAD_ILOSCI");
      expect(bad.quantityError, text).toBeTruthy();
    }
  });

  it("ilość po zaokrągleniu do 0 → BLAD_ILOSCI", () => {
    const [p] = preview([line("H1", 0.0004, "m", 1)], { H1: res(mat("H1", "mb")) });
    expect(p.status).toBe("BLAD_ILOSCI");
  });

  it("podsumowanie: gotowe / do rozwiązania / pominięte", () => {
    const rows = preview(
      [line("A1", 1, "szt.", 1), line("B1", 1, "szt.", 2), line("C1", 1, "szt.", 3), line("D1", 1, "m", 4, { isProfile: true })],
      { A1: res(mat("A1", "szt.")), B1: res(null, "UNKNOWN"), C1: { code: "C1", status: "IGNORED", aliasId: null, material: null } },
    );
    expect(summarizePreview(rows)).toEqual({ ready: 1, toResolve: 1, skipped: 2 });
  });
});

describe("ręczna zmiana ilości", () => {
  it("status „Ręcznie”, przeliczenie zostaje jako propozycja, brak metrów do scalania; wartość równa propozycji — bez zmiany", () => {
    const resolutions = { P1: res(mat("P1", "szt.", { barLengthM: 6.5 })) };
    const lines = [line("P1", 44.2, "m", 1)];
    const auto = preview(lines, resolutions)[0];
    expect(auto).toMatchObject({ status: "PRZELICZONO", quantity: 7, manual: false, meters: 44.2 });
    const manual = preview(lines, resolutions, undefined, { P1: { quantityText: "8" } })[0];
    expect(manual).toMatchObject({ status: "RECZNIE", quantity: 8, manual: true, meters: null, suggestedQuantity: 7, conversion: "44,2 m → 7 szt." });
    expect(preview(lines, resolutions, undefined, { P1: { quantityText: "7" } })[0]).toMatchObject({ status: "PRZELICZONO", manual: false });
  });
});

describe("scalanie kodów o tym samym materiale", () => {
  const bar = mat("P1", "szt.", { barLengthM: 6.5 });
  const two = (a: ParsedLine, b: ParsedLine, overrides: Record<string, ItemOverride> = {}) =>
    preview([a, b], { A1: res(bar, "ALIAS_MAP"), A2: res(bar, "ALIAS_MAP") }, undefined, overrides);

  it("same przeliczone metry → ceil(Σm / L), nie suma osobnych ceil", () => {
    const rows = two(line("A1", 3.2, "m", 1), line("A2", 3.2, "m", 2));
    expect(rows.map((r) => r.quantity)).toEqual([1, 1]);
    const { items, merged } = buildImportItems(rows);
    expect(merged).toBe(1);
    expect(items).toHaveLength(1);
    expect(items[0].quantity).toBe(1);
  });

  it("dokładna wielokrotność sumy metrów i zaokrąglenie w górę", () => {
    expect(buildImportItems(two(line("A1", 6.5, "m", 1), line("A2", 6.5, "m", 2))).items[0].quantity).toBe(2);
    expect(buildImportItems(two(line("A1", 6.5, "m", 1), line("A2", 0.1, "m", 2))).items[0].quantity).toBe(2);
  });

  it("mieszane jednostki (m + szt.) albo ręczna ilość → suma ilości policzonych per kod", () => {
    const mixed = two(line("A1", 3.2, "m", 1), line("A2", 2, "szt.", 2));
    expect(mixed.map((r) => r.quantity)).toEqual([1, 2]);
    expect(buildImportItems(mixed).items[0].quantity).toBe(3);
    const manual = two(line("A1", 3.2, "m", 1), line("A2", 3.2, "m", 2), { A1: { quantityText: "4" } });
    expect(buildImportItems(manual).items[0].quantity).toBe(5);
  });
});

describe("raw_source_ref", () => {
  it("zawiera kod, numery wierszy i sumę (≤ 200 znaków)", () => {
    const [item] = aggregateLines([line("P2102 30/10/AR-RAL7016-FS", 0.55, "m", 123), line("P2102 30/10/AR-RAL7016-FS", 43.65, "m", 124)]);
    expect(buildRawSourceRef(item)).toBe("LiczOkno: P2102 30/10/AR-RAL7016-FS w. 123, 124: 44,2 m");
  });

  it("cięcie po code pointach nie rozcina par zastępczych", () => {
    const [item] = aggregateLines([line("A1", 1, "szt.", 1)]);
    const ref = buildRawSourceRef({ ...item, code: "\u{1F600}".repeat(200) });
    expect(Array.from(ref).length).toBeLessThanOrEqual(200);
    expect(ref.endsWith("…")).toBe(true);
    expect(ref).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("zawsze ≤ 200 znaków, także dla bardzo wielu wierszy i długiego kodu", () => {
    const lines = Array.from({ length: 300 }, (_, i) => line("K".repeat(50), 1, "szt.", 1000 + i));
    const [item] = aggregateLines(lines);
    const ref = buildRawSourceRef(item);
    expect(ref.length).toBeLessThanOrEqual(200);
    expect(ref.startsWith("LiczOkno: KKKK")).toBe(true);
    expect(buildPreview([item], new Map([[item.key, res(mat("K", "szt."))]]), { includeProfiles: false })[0].rawSourceRef.length).toBeLessThanOrEqual(200);
  });
});

describe("pozycje do wysłania", () => {
  it("tylko gotowe pozycje; ilość i odwołanie do pliku", () => {
    const rows = preview(
      [line("A1", 3, "szt.", 1), line("B1", 1, "szt.", 2)],
      { A1: res(mat("A1", "szt.")), B1: res(null, "UNKNOWN") },
    );
    const { items, merged } = buildImportItems(rows);
    expect(merged).toBe(0);
    expect(items).toEqual([{ material_id: "id-A1", quantity: 3, raw_source_ref: "LiczOkno: A1 w. 1: 3 szt." }]);
  });

  it("dwa kody wskazujące ten sam materiał są scalane (suma, połączone odwołania ≤ 200)", () => {
    const shared = mat("M1", "szt.");
    const rows = preview(
      [line("A1", 3, "szt.", 1), line("A2", 4, "szt.", 2)],
      { A1: res(shared, "ALIAS_MAP"), A2: res(shared, "ALIAS_MAP") },
    );
    const { items, merged } = buildImportItems(rows);
    expect(merged).toBe(1);
    expect(items).toHaveLength(1);
    expect(items[0].quantity).toBe(7);
    expect(items[0].raw_source_ref).toBe("LiczOkno: A1 w. 1: 3 szt. | A2 w. 2: 4 szt.");
    expect(items[0].raw_source_ref.length).toBeLessThanOrEqual(200);
  });
});
