import { describe, expect, it } from "vitest";
import { checkMinQuantity, createMaterialSchema, updateMaterialSchema } from "@/lib/validation/catalog";
import { exportStockQuerySchema, listStockQuerySchema, listTotalsQuerySchema } from "@/lib/validation/stock";

const CATEGORY = "7a2d2f1b-3c1e-4d4f-8a6b-2c3d4e5f6071";
const base = { code: "k1", name: "Profil", category_id: CATEGORY, unit: "szt." };

describe("checkMinQuantity", () => {
  it("puste / null / spacje → null (brak alarmu)", () => {
    for (const v of [null, undefined, "", "   "]) expect(checkMinQuantity(v)).toEqual({ ok: true, value: null });
  });

  it("liczby i teksty z przecinkiem", () => {
    expect(checkMinQuantity("10")).toEqual({ ok: true, value: 10 });
    expect(checkMinQuantity("2,5")).toEqual({ ok: true, value: 2.5 });
    expect(checkMinQuantity(0)).toEqual({ ok: true, value: 0 });
    expect(checkMinQuantity("1 000")).toEqual({ ok: true, value: 1000 });
    expect(checkMinQuantity("5,")).toEqual({ ok: true, value: 5 });
    expect(checkMinQuantity("5.")).toEqual({ ok: true, value: 5 });
    expect(checkMinQuantity(".").ok).toBe(false);
    expect(checkMinQuantity("5,5.").ok).toBe(true);
  });

  it("odrzuca ujemne, nieliczbowe, > 3 miejsc, > 1 000 000", () => {
    for (const v of ["-1", "abc", "1,2345", "1000001", Number.NaN, {}, true]) {
      expect(checkMinQuantity(v).ok, String(v)).toBe(false);
    }
  });
});

describe("schemat materiału z min_quantity", () => {
  it("create: ułamek przy allows_fraction=false → błąd na polu min_quantity", () => {
    const r = createMaterialSchema.safeParse({ ...base, allows_fraction: false, min_quantity: "2,5" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(["min_quantity"]);
  });

  it("create: ułamek przy allows_fraction=true i całkowite przy false są OK; brak pola → bez zmian", () => {
    const ok = createMaterialSchema.parse({ ...base, allows_fraction: true, min_quantity: "2,5" });
    expect(ok.min_quantity).toBe(2.5);
    expect(createMaterialSchema.parse({ ...base, allows_fraction: false, min_quantity: "3" }).min_quantity).toBe(3);
    expect(createMaterialSchema.parse(base).min_quantity).toBeUndefined();
    expect(createMaterialSchema.parse({ ...base, min_quantity: "" }).min_quantity).toBeNull();
  });

  it("update: min_quantity: null czyści minimum i liczy się jako zmiana; ujemne → błąd", () => {
    expect(updateMaterialSchema.parse({ min_quantity: null }).min_quantity).toBeNull();
    expect(updateMaterialSchema.safeParse({ min_quantity: "-1" }).success).toBe(false);
    expect(updateMaterialSchema.safeParse({ allows_fraction: false, min_quantity: 1.5 }).success).toBe(false);
    expect(updateMaterialSchema.safeParse({ allows_fraction: true, min_quantity: 1.5 }).success).toBe(true);
  });
});

describe("parametry list stanów i eksportu", () => {
  it("stock: categoryId i belowMin", () => {
    const q = listStockQuerySchema.parse({ categoryId: CATEGORY, belowMin: "true" });
    expect(q.categoryId).toBe(CATEGORY);
    expect(q.belowMin).toBe(true);
    expect(listStockQuerySchema.parse({}).belowMin).toBe(false);
    expect(listStockQuerySchema.safeParse({ categoryId: "x" }).success).toBe(false);
  });

  it("totals i export", () => {
    expect(listTotalsQuerySchema.parse({ belowMin: "1" }).belowMin).toBe(true);
    expect(exportStockQuerySchema.parse({ variant: "material" }).variant).toBe("material");
    expect(exportStockQuerySchema.safeParse({ variant: "x" }).success).toBe(false);
    expect(exportStockQuerySchema.safeParse({}).success).toBe(false);
  });
});
