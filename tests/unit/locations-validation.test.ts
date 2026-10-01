import { describe, expect, it } from "vitest";
import { locationHref } from "@/app/m/lokalizacje/href";
import {
  bulkLocationsSchema,
  createLocationSchema,
  decodeCodeParam,
  qrPayloadForLocation,
  generateLocationSeries,
  labelIdsSchema,
  listLocationsQuerySchema,
  locationCodeSchema,
  parseScannedCode,
  updateLocationSchema,
} from "@/lib/validation/locations";

const UUID = "6f1c1e0a-2b0d-4c3e-9f5a-1b2c3d4e5f60";
const UUID2 = "7f1c1e0a-2b0d-4c3e-9f5a-1b2c3d4e5f61";

describe("kod lokalizacji", () => {
  it("przycina i zamienia na wielkie litery", () => {
    expect(locationCodeSchema.parse("  a-03-02 ")).toBe("A-03-02");
    expect(locationCodeSchema.parse("r1.p-2_x")).toBe("R1.P-2_X");
  });

  it.each(["", "   ", "A 03", "A;B", "ĄĆ", "A*B", "A/B", "A:B", "A".repeat(21), "---", "..", "."])("odrzuca %j", (code) => {
    expect(locationCodeSchema.safeParse(code).success).toBe(false);
  });

  it("akceptuje 20 znaków", () => {
    expect(locationCodeSchema.safeParse("A".repeat(20)).success).toBe(true);
  });
});

describe("parseScannedCode (wynik skanu / ręczny wpis)", () => {
  it("trim + UPPERCASE", () => {
    expect(parseScannedCode(" a-03-02\n")).toBe("A-03-02");
  });

  it("akceptuje treść QR L:<kod> (preferowana) oraz sam kod", () => {
    expect(parseScannedCode("L:A-03-02")).toBe("A-03-02");
    expect(parseScannedCode(" l:a-03-02 ")).toBe("A-03-02");
    expect(parseScannedCode("A-03-02")).toBe("A-03-02");
    expect(parseScannedCode(qrPayloadForLocation("R1.P_2-X"))).toBe("R1.P_2-X");
  });

  it.each([
    "",
    "   ",
    "L:",
    "x".repeat(21),
    "L:" + "x".repeat(21),
    "https://example.com/a",
    "A B",
    "<script>",
    "X:A-03-02",
    "M:K518",
    "L:L:A-1",
    "A/B",
  ])("odrzuca %j", (raw) => {
    expect(parseScannedCode(raw)).toBeNull();
  });
});

describe("locationHref i decodeCodeParam (trasa /m/lokalizacje/[code])", () => {
  it.each(["A-03-02", "R1.P_2-X", "A.B", "A_1", "-A-", "TEST-1A2B3C4D-L1"])("round-trip dla %j", (code) => {
    const href = locationHref(code);
    expect(href).toBe(`/m/lokalizacje/${encodeURIComponent(code)}`);
    expect(href.split("/")).toHaveLength(4); // dokładnie jeden segment kodu
    expect(decodeCodeParam(href.split("/")[3])).toBe(code);
  });

  it("zepsute kodowanie → null (404, nie 500)", () => {
    expect(decodeCodeParam("%E0%A4%A")).toBeNull();
    expect(decodeCodeParam("%")).toBeNull();
    expect(decodeCodeParam("A%2DB")).toBe("A-B");
  });
});

describe("create/update lokalizacji", () => {
  it("puste pola opcjonalne → null, kod znormalizowany", () => {
    expect(createLocationSchema.parse({ code: "a-1", name: "  ", description: "" })).toEqual({
      code: "A-1",
      name: null,
      description: null,
    });
  });

  it("limity nazwy (100) i opisu (500)", () => {
    expect(createLocationSchema.safeParse({ code: "A", name: "x".repeat(101) }).success).toBe(false);
    expect(createLocationSchema.safeParse({ code: "A", description: "x".repeat(501) }).success).toBe(false);
    expect(createLocationSchema.safeParse({ code: "A", name: "x".repeat(100) }).success).toBe(true);
  });

  it("odrzuca nieznane pola (id, created_by)", () => {
    expect(createLocationSchema.safeParse({ code: "A", created_by: UUID }).success).toBe(false);
    expect(updateLocationSchema.safeParse({ id: UUID }).success).toBe(false);
  });

  it("PATCH wymaga co najmniej jednej zmiany", () => {
    expect(updateLocationSchema.safeParse({}).success).toBe(false);
    expect(updateLocationSchema.safeParse({ active: false }).success).toBe(true);
  });
});

describe("bulk", () => {
  const items = (n: number) => Array.from({ length: n }, (_, i) => ({ code: `A-${i + 1}` }));

  it("akceptuje 1–200, odrzuca 0 i 201", () => {
    expect(bulkLocationsSchema.safeParse({ items: items(1) }).success).toBe(true);
    expect(bulkLocationsSchema.safeParse({ items: items(200) }).success).toBe(true);
    expect(bulkLocationsSchema.safeParse({ items: [] }).success).toBe(false);
    expect(bulkLocationsSchema.safeParse({ items: items(201) }).success).toBe(false);
  });

  it("odrzuca duplikaty na liście (po normalizacji)", () => {
    const r = bulkLocationsSchema.safeParse({ items: [{ code: "a-1" }, { code: "A-1 " }] });
    expect(r.success).toBe(false);
  });

  it("normalizuje kody", () => {
    expect(bulkLocationsSchema.parse({ items: [{ code: "a-1", name: " x " }] }).items[0]).toEqual({ code: "A-1", name: "x" });
  });
});

describe("generator kodów seryjnych", () => {
  it("regał A, półki 1–2, poziomy 1–3 → 6 kodów z zerami wiodącymi", () => {
    const r = generateLocationSeries({ rack: "a", shelfFrom: 1, shelfTo: 2, levelFrom: 1, levelTo: 3 });
    expect(r.ok && r.items.map((i) => i.code)).toEqual(["A-01-01", "A-01-02", "A-01-03", "A-02-01", "A-02-02", "A-02-03"]);
    expect(r.ok && r.items[0].name).toBe("Regał A, półka 1, poziom 1");
  });

  it("zera wiodące do liczby cyfr maksimum zakresu (min. 2), osobno dla półek i poziomów", () => {
    const r = generateLocationSeries({ rack: "B", shelfFrom: 9, shelfTo: 10, levelFrom: 99, levelTo: 100 });
    expect(r.ok && r.items.map((i) => i.code)).toEqual(["B-09-099", "B-09-100", "B-10-099", "B-10-100"]);
    const wide = generateLocationSeries({ rack: "C", shelfFrom: 8, shelfTo: 120, levelFrom: 1, levelTo: 1 });
    expect(wide.ok && wide.items[0].code).toBe("C-008-01");
    expect(wide.ok && wide.items.at(-1)?.code).toBe("C-120-01");
    const big = generateLocationSeries({ rack: "A", shelfFrom: 1, shelfTo: 5, levelFrom: 1, levelTo: 4 });
    expect(big.ok && big.items).toHaveLength(20);
  });

  it("pojedyncza lokalizacja (od = do)", () => {
    const r = generateLocationSeries({ rack: "Z", shelfFrom: 3, shelfTo: 3, levelFrom: 2, levelTo: 2 });
    expect(r.ok && r.items.map((i) => i.code)).toEqual(["Z-03-02"]);
  });

  it("limit 200: dokładnie 200 ok, 201 odrzucone", () => {
    expect(generateLocationSeries({ rack: "A", shelfFrom: 1, shelfTo: 20, levelFrom: 1, levelTo: 10 }).ok).toBe(true);
    const over = generateLocationSeries({ rack: "A", shelfFrom: 1, shelfTo: 201, levelFrom: 1, levelTo: 1 });
    expect(over.ok).toBe(false);
  });

  it.each([
    { rack: "", shelfFrom: 1, shelfTo: 1, levelFrom: 1, levelTo: 1 },
    { rack: "A B", shelfFrom: 1, shelfTo: 1, levelFrom: 1, levelTo: 1 },
    { rack: "A-1", shelfFrom: 1, shelfTo: 1, levelFrom: 1, levelTo: 1 },
    { rack: "A".repeat(11), shelfFrom: 1, shelfTo: 1, levelFrom: 1, levelTo: 1 },
    { rack: "A", shelfFrom: 0, shelfTo: 1, levelFrom: 1, levelTo: 1 },
    { rack: "A", shelfFrom: 3, shelfTo: 2, levelFrom: 1, levelTo: 1 },
    { rack: "A", shelfFrom: 1, shelfTo: 1, levelFrom: 1.5, levelTo: 2 },
    { rack: "A", shelfFrom: 1, shelfTo: 1, levelFrom: 1, levelTo: 1000 },
    { rack: "A", shelfFrom: NaN, shelfTo: 1, levelFrom: 1, levelTo: 1 },
  ])("odrzuca niepoprawne wejście %j", (input) => {
    expect(generateLocationSeries(input).ok).toBe(false);
  });

  it("wygenerowane kody przechodzą walidację bulk (długość ≤ 20)", () => {
    const r = generateLocationSeries({ rack: "ABCDEFGHIJ", shelfFrom: 1, shelfTo: 20, levelFrom: 1, levelTo: 10 });
    expect(r.ok && bulkLocationsSchema.safeParse({ items: r.items }).success).toBe(true);
    // najgorszy przypadek: 10 + 1 + 3 + 1 + 3 = 18 znaków
    const worst = generateLocationSeries({ rack: "ABCDEFGHIJ", shelfFrom: 999, shelfTo: 999, levelFrom: 999, levelTo: 999 });
    expect(worst.ok && worst.items[0].code.length).toBe(18);
    expect(worst.ok && bulkLocationsSchema.safeParse({ items: worst.items }).success).toBe(true);
  });
});

describe("parametry listy i etykiet", () => {
  it("domyślne wartości i limit pageSize", () => {
    expect(listLocationsQuerySchema.parse({})).toMatchObject({ page: 1, pageSize: 25, includeInactive: false });
    expect(listLocationsQuerySchema.safeParse({ pageSize: "101" }).success).toBe(false);
    expect(listLocationsQuerySchema.safeParse({ q: "x".repeat(101) }).success).toBe(false);
  });

  it("ids: unikalne UUID, 1–200, odrzuca śmieci", () => {
    expect(labelIdsSchema.parse(`${UUID},${UUID2},${UUID}`)).toEqual([UUID, UUID2]);
    expect(labelIdsSchema.safeParse("").success).toBe(false);
    expect(labelIdsSchema.safeParse("abc").success).toBe(false);
    const many = Array.from({ length: 201 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(labelIdsSchema.safeParse(many.join(",")).success).toBe(false);
  });
});
