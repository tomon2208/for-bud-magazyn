import { describe, expect, it } from "vitest";
import { buildImportPayload, requestIdFor, type ImportSaveInput } from "@/modules/liczokno-import/payload";

const base: ImportSaveInput = {
  targetOrderId: "6f1c1e0a-2b0d-4c3e-9f5a-1b2c3d4e5f60",
  orderName: "ignorowane przy istniejącym",
  orderNumber: "",
  listName: "Lista",
  fileName: "lista.xls",
  formatId: "liczokno-lista-materialowa",
  items: [{ material_id: "m1", quantity: 2, raw_source_ref: "LiczOkno: A1 w. 4: 2 szt." }],
};

describe("buildImportPayload", () => {
  it("istniejące zlecenie → order_id (bez new_order); nowe zlecenie → new_order (bez order_id)", () => {
    const existing = buildImportPayload(base).body;
    expect(existing).toMatchObject({ order_id: base.targetOrderId, name: "Lista", file_name: "lista.xls", import_format: "liczokno-lista-materialowa" });
    expect(existing).not.toHaveProperty("new_order");
    const created = buildImportPayload({ ...base, targetOrderId: null, orderName: "Kowalski", orderNumber: "Z-1" }).body;
    expect(created.new_order).toEqual({ name: "Kowalski", number: "Z-1" });
    expect(created).not.toHaveProperty("order_id");
  });

  it("klucz jest stabilny dla identycznej treści i zmienia się przy każdej zmianie treści", () => {
    const key = buildImportPayload(base).key;
    expect(buildImportPayload({ ...base, items: base.items.map((i) => ({ ...i })) }).key).toBe(key);
    for (const changed of [
      { ...base, listName: "Inna" },
      { ...base, fileName: "inny.xls" },
      { ...base, targetOrderId: "7a2d2f1b-3c1e-4d4f-8a6b-2c3d4e5f6071" },
      { ...base, items: [{ ...base.items[0], quantity: 3 }] },
      { ...base, items: [{ ...base.items[0], raw_source_ref: "inne" }] },
      { ...base, items: [...base.items, { material_id: "m2", quantity: 1, raw_source_ref: "x" }] },
    ]) {
      expect(buildImportPayload(changed).key).not.toBe(key);
    }
    const a = buildImportPayload({ ...base, targetOrderId: null, orderName: "A" }).key;
    expect(buildImportPayload({ ...base, targetOrderId: null, orderName: "B" }).key).not.toBe(a);
  });
});

describe("requestIdFor", () => {
  it("ten sam identyfikator dla tego samego klucza, nowy po zmianie", () => {
    let n = 0;
    const gen = () => `id-${++n}`;
    const first = requestIdFor(null, "k1", gen);
    expect(first).toEqual({ key: "k1", id: "id-1" });
    expect(requestIdFor(first, "k1", gen)).toBe(first);
    expect(requestIdFor(first, "k2", gen)).toEqual({ key: "k2", id: "id-2" });
  });
});
