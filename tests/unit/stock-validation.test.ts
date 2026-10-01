import { describe, expect, it } from "vitest";
import { createMaterialSchema, updateMaterialSchema } from "@/lib/validation/catalog";
import {
  checkQuantity,
  endSentence,
  formatQuantity,
  formatQuantityUnit,
  quantitySchema,
  receiptSchema,
  unitAllowsFraction,
} from "@/lib/validation/stock";
import { mapStockError } from "@/server/stock";

describe("checkQuantity — wejście z polskiej klawiatury", () => {
  it.each([
    ["1,5", 1.5],
    ["1.5", 1.5],
    [" 12 ", 12],
    ["0,125", 0.125],
    ["1 000", 1000],
    ["1 000,5", 1000.5],
    ["2,000", 2],
    ["1000000", 1_000_000],
    [7, 7],
    [0.001, 0.001],
    [",5", 0.5],
    [".5", 0.5],
    ["12.5", 12.5],
    ["1.25", 1.25],
  ] as const)("%j → %d", (raw, expected) => {
    expect(checkQuantity(raw)).toEqual({ ok: true, value: expected });
  });

  it.each([
    ["", "Podaj ilość"],
    ["abc", "liczbą"],
    ["1,2,3", "liczbą"],
    ["1e3", "liczbą"],
    [",", "liczbą"],
    [".", "liczbą"],
    ["1.500", "przecinka"],
    ["12.345.678", "przecinka"],
    ["1.000", "przecinka"],
    ["0", "większa od zera"],
    ["0,000", "większa od zera"],
    ["-1", "większa od zera"],
    [-1, "większa od zera"],
    ["1,2345", "3 miejsca"],
    ["1000000,001", "1 000 000"],
    [Number.NaN, "Podaj ilość"],
    [null, "Podaj ilość"],
  ] as const)("%j → błąd (%s)", (raw, fragment) => {
    const r = checkQuantity(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain(fragment);
  });

  it("całkowitość gdy materiał nie dopuszcza ułamków", () => {
    expect(checkQuantity("1,5", false)).toMatchObject({ ok: false, message: expect.stringContaining("całych") });
    expect(checkQuantity("3", false)).toEqual({ ok: true, value: 3 });
    expect(checkQuantity("3,000", false)).toEqual({ ok: true, value: 3 });
    expect(quantitySchema(false).safeParse("1,5").success).toBe(false);
    expect(quantitySchema(true).parse("1,5")).toBe(1.5);
  });
});

describe("unitAllowsFraction (jak app.unit_allows_fraction)", () => {
  it.each([
    ["szt.", false],
    ["SZT", false],
    ["sztanga", false],
    ["Sztanga", false],
    ["opak.", false],
    ["OPAK", false],
    ["kpl", false],
    ["KPL.", false],
    ["komplet", false],
    ["Para", false],
    ["rolka", false],
    ["mb", true],
    ["kg", true],
    ["l", true],
    ["m²", true],
  ] as const)("%s → %s", (unit, expected) => {
    expect(unitAllowsFraction(unit)).toBe(expected);
  });
});

describe("receiptSchema", () => {
  const base = {
    client_request_id: "0b8f8a3e-4a4c-4c86-9a43-0f0f7e1d2c3b",
    location_id: "6f1c1e0a-2b0d-4c3e-9f5a-1b2c3d4e5f60",
    material_id: "7a2d2f1b-3c1e-4d4f-8a6b-2c3d4e5f6071",
    quantity: "2,5",
  };
  it("normalizuje ilość i teksty", () => {
    expect(receiptSchema.parse({ ...base, supplier_id: null, document_ref: " FV 1 ", note: "" })).toEqual({
      ...base,
      quantity: 2.5,
      supplier_id: null,
      document_ref: "FV 1",
      note: null,
    });
  });
  it("strict: odrzuca nieznane pola", () => {
    expect(receiptSchema.safeParse({ ...base, user_id: base.location_id }).success).toBe(false);
  });
});

describe("materiał: allows_fraction w schematach", () => {
  it("opcjonalne boolean", () => {
    const m = { code: "x", name: "n", category_id: "6f1c1e0a-2b0d-4c3e-9f5a-1b2c3d4e5f60", unit: "szt." };
    expect(createMaterialSchema.parse(m).allows_fraction).toBeUndefined();
    expect(createMaterialSchema.parse({ ...m, allows_fraction: true }).allows_fraction).toBe(true);
    expect(createMaterialSchema.safeParse({ ...m, allows_fraction: "tak" }).success).toBe(false);
    expect(updateMaterialSchema.parse({ allows_fraction: false })).toEqual({ allows_fraction: false });
  });
});

describe("mapStockError", () => {
  it.each([
    [{ code: "42501" }, 403, "FORBIDDEN"],
    [{ code: "P0001", hint: "MATERIAL_INACTIVE" }, 400, "MATERIAL_INACTIVE"],
    [{ code: "P0001", hint: "LOCATION_INACTIVE" }, 400, "LOCATION_INACTIVE"],
    [{ code: "P0001", hint: "SUPPLIER_INACTIVE" }, 400, "SUPPLIER_INACTIVE"],
    [{ code: "P0001", hint: "NOT_INTEGER" }, 400, "NOT_INTEGER"],
    [{ code: "P0001", hint: "INVALID_QUANTITY" }, 400, "INVALID_QUANTITY"],
    [{ code: "P0001", hint: "IDEMPOTENCY_CONFLICT" }, 409, "IDEMPOTENCY_CONFLICT"],
    [{ code: "P0001", hint: "NOT_FOUND", details: "material" }, 404, "NOT_FOUND"],
    [{ code: "23505" }, 409, "RETRY"],
    [{ code: "22003" }, 400, "STOCK_LIMIT"],
    [{ code: "XX000" }, 500, "INTERNAL"],
  ])("%j → %d %s", (error, status, code) => {
    expect(mapStockError(error, "test")).toMatchObject({ status, code });
  });

  it("NOT_FOUND: komunikat wg obiektu", () => {
    expect(mapStockError({ code: "P0001", hint: "NOT_FOUND", details: "location" }, "t").message).toBe(
      "Nie znaleziono lokalizacji",
    );
  });
});

describe("formatQuantityUnit / endSentence (L6)", () => {
  it("bez podwójnej kropki po jednostce „szt.”", () => {
    expect(endSentence(`Stan: ${formatQuantityUnit(3, "szt.")}`)).toBe("Stan: 3 szt.");
    expect(endSentence(`Stan: ${formatQuantityUnit(2.5, "mb")}`)).toBe("Stan: 2,5 mb.");
  });
});

describe("formatQuantity", () => {
  it("polski format, max 3 miejsca", () => {
    expect(formatQuantity(1.5)).toBe("1,5");
    expect(formatQuantity(12)).toBe("12");
    expect(formatQuantity(0.125)).toBe("0,125");
  });
});
