import { describe, expect, it } from "vitest";
import { createMaterialSchema, updateMaterialSchema } from "@/lib/validation/catalog";
import {
  checkQuantity,
  endSentence,
  formatQuantity,
  formatQuantityUnit,
  issueReasonLabel,
  issueSchema,
  quantitySchema,
  receiptSchema,
  transferSchema,
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

// ---------------------------------------------------------------------------
// Etap 5: wydanie i przesunięcie
// ---------------------------------------------------------------------------
const U1 = "0b8f8a3e-4a4c-4c86-9a43-0f0f7e1d2c3b";
const U2 = "6f1c1e0a-2b0d-4c3e-9f5a-1b2c3d4e5f60";
const U3 = "7a2d2f1b-3c1e-4d4f-8a6b-2c3d4e5f6071";
const U4 = "8b3e3a2c-4d2f-4e5a-9b7c-3d4e5f607182";

describe("issueSchema — zlecenie XOR powód", () => {
  const base = { client_request_id: U1, location_id: U2, material_id: U3, quantity: "2" };
  const ok = (v: unknown) => issueSchema.safeParse(v);

  it("na zlecenie: OK; ilość z przecinkiem → liczba", () => {
    const r = ok({ ...base, quantity: "1,5", production_order_id: U4 });
    expect(r.success && r.data).toMatchObject({ production_order_id: U4, quantity: 1.5 });
  });

  it.each(["SERWIS", "USZKODZENIE", "ZUZYCIE_WLASNE", "PROBKA"])("powód %s bez opisu: OK", (code) => {
    expect(ok({ ...base, reason_code: code }).success).toBe(true);
  });

  it("INNY z opisem: OK (opis przycięty)", () => {
    const r = ok({ ...base, reason_code: "INNY", reason: "  zwrot do dostawcy " });
    expect(r.success && r.data.reason).toBe("zwrot do dostawcy");
  });

  it.each([
    ["ani zlecenia, ani powodu", { ...base }, "production_order_id"],
    ["zlecenie i powód naraz", { ...base, production_order_id: U4, reason_code: "SERWIS" }, "production_order_id"],
    ["null i null", { ...base, production_order_id: null, reason_code: null }, "production_order_id"],
    ["INNY bez opisu", { ...base, reason_code: "INNY" }, "reason"],
    ["INNY z pustym opisem", { ...base, reason_code: "INNY", reason: "   " }, "reason"],
    ["opis przy zleceniu", { ...base, production_order_id: U4, reason: "x" }, "reason"],
    ["nieznany powód", { ...base, reason_code: "KRADZIEZ" }, "reason_code"],
    ["opis > 200", { ...base, reason_code: "INNY", reason: "x".repeat(201) }, "reason"],
    ["zlecenie nie-uuid", { ...base, production_order_id: "abc" }, "production_order_id"],
    ["ilość 0", { ...base, reason_code: "SERWIS", quantity: 0 }, "quantity"],
    ["nieznane pole", { ...base, reason_code: "SERWIS", user_id: U1 }, ""],
  ])("%s → błąd", (_n, input, field) => {
    const r = ok(input);
    expect(r.success).toBe(false);
    if (!r.success && field) expect(r.error.issues.map((i) => i.path.join("."))).toContain(field);
  });
});

describe("transferSchema", () => {
  const base = { client_request_id: U1, material_id: U3, from_location_id: U2, to_location_id: U4, quantity: "3" };
  it("OK", () => {
    const r = transferSchema.safeParse(base);
    expect(r.success && r.data.quantity).toBe(3);
  });
  it("skąd = dokąd → błąd na to_location_id", () => {
    const r = transferSchema.safeParse({ ...base, to_location_id: U2 });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]).toMatchObject({ path: ["to_location_id"] });
  });
  it.each([
    ["brak dokąd", { ...base, to_location_id: undefined }],
    ["ilość ujemna", { ...base, quantity: "-1" }],
    ["nieznane pole", { ...base, location_id: U2 }],
  ])("%s → błąd", (_n, input) => {
    expect(transferSchema.safeParse(input).success).toBe(false);
  });
});

describe("mapStockError — Etap 5", () => {
  it.each([
    [{ code: "P0001", hint: "ISSUE_TARGET" }, 400, "ISSUE_TARGET"],
    [{ code: "P0001", hint: "REASON_REQUIRED" }, 400, "REASON_REQUIRED"],
    [{ code: "P0001", hint: "ORDER_NOT_OPEN" }, 409, "ORDER_NOT_OPEN"],
    [{ code: "P0001", hint: "SAME_LOCATION" }, 400, "SAME_LOCATION"],
    [{ code: "P0001", hint: "NOT_FOUND", details: "order" }, 404, "NOT_FOUND"],
  ])("%o → %i %s", (error, status, code) => {
    expect(mapStockError(error, "test")).toMatchObject({ status, code });
  });

  it("INSUFFICIENT_STOCK: 409 z dostępną ilością z detail", () => {
    expect(mapStockError({ code: "P0001", hint: "INSUFFICIENT_STOCK", details: "7.500" }, "t")).toEqual({
      status: 409,
      code: "INSUFFICIENT_STOCK",
      message: "Niewystarczający stan w lokalizacji. Dostępne: 7,5",
      details: { available: 7.5 },
    });
    // Nieczytelny detail → 0 (bez NaN w odpowiedzi).
    expect(mapStockError({ code: "P0001", hint: "INSUFFICIENT_STOCK", details: null }, "t").details).toEqual({ available: 0 });
  });

  it("issueReasonLabel", () => {
    expect(issueReasonLabel("ZUZYCIE_WLASNE")).toBe("Zużycie własne");
    expect(issueReasonLabel(null)).toBe("");
  });
});
