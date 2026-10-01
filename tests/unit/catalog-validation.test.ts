import { describe, expect, it } from "vitest";
import {
  buildIlikeContainsValue,
  createCategorySchema,
  createMaterialSchema,
  createSupplierSchema,
  likeContains,
  listMaterialsQuerySchema,
  materialCodeSchema,
  updateMaterialSchema,
  updateSupplierSchema,
} from "@/lib/validation/catalog";

const UUID = "6f1c1e0a-2b0d-4c3e-9f5a-1b2c3d4e5f60";
const UUID2 = "7f1c1e0a-2b0d-4c3e-9f5a-1b2c3d4e5f61";

describe("kod materiału", () => {
  it("przycina i zamienia na wielkie litery", () => {
    expect(materialCodeSchema.parse("  ab-12.x/y_z ")).toBe("AB-12.X/Y_Z");
  });

  it("pojedyncze spacje wewnątrz: wielokrotne białe znaki → jedna spacja, brzegi przycięte", () => {
    expect(materialCodeSchema.parse("  k518   ral9016 ")).toBe("K518 RAL9016");
    expect(materialCodeSchema.parse("a\t b\n c")).toBe("A B C");
    expect(materialCodeSchema.parse(" x ")).toBe("X");
  });

  it.each(["", "   ", "ĄĆ", "A;B", "A,B", "A*B", "A".repeat(51), `${"A".repeat(25)} ${"B".repeat(25)}`])(
    "odrzuca %j",
    (code) => {
      expect(materialCodeSchema.safeParse(code).success).toBe(false);
    },
  );

  it("akceptuje 50 znaków (także ze spacją)", () => {
    expect(materialCodeSchema.safeParse("a".repeat(50)).success).toBe(true);
    expect(materialCodeSchema.safeParse(`${"a".repeat(24)} ${"b".repeat(25)}`).success).toBe(true);
  });
});

describe("kategorie i dostawcy", () => {
  it("nazwa kategorii: trim, niepusta, max 80, .strict()", () => {
    expect(createCategorySchema.parse({ name: "  Okucia " })).toEqual({ name: "Okucia" });
    expect(createCategorySchema.safeParse({ name: "  " }).success).toBe(false);
    expect(createCategorySchema.safeParse({ name: "x".repeat(81) }).success).toBe(false);
    expect(createCategorySchema.safeParse({ name: "ok", active: false }).success).toBe(false);
  });

  it("dostawca: puste pola opcjonalne → null, limity", () => {
    expect(createSupplierSchema.parse({ name: " ACME ", phone: "  ", email: "" })).toEqual({
      name: "ACME",
      phone: null,
      email: null,
    });
    expect(createSupplierSchema.safeParse({ name: "x".repeat(201) }).success).toBe(false);
    expect(createSupplierSchema.safeParse({ name: "x", notes: "n".repeat(2001) }).success).toBe(false);
    expect(createSupplierSchema.safeParse({ name: "x", unknown: 1 }).success).toBe(false);
  });

  it("aktualizacja dostawcy: wymaga zmiany, nie pozwala na obce pola", () => {
    expect(updateSupplierSchema.safeParse({}).success).toBe(false);
    expect(updateSupplierSchema.safeParse({ id: UUID }).success).toBe(false);
    expect(updateSupplierSchema.safeParse({ active: false }).success).toBe(true);
    expect(updateSupplierSchema.parse({ phone: "" })).toEqual({ phone: null });
  });
});

describe("materiał", () => {
  const valid = { code: "pr-01", name: "Profil", category_id: UUID, unit: "sztanga" };

  it("normalizuje kod i przycina pola", () => {
    expect(createMaterialSchema.parse({ ...valid, name: "  Profil  ", unit: " szt. " })).toEqual({
      ...valid,
      code: "PR-01",
      name: "Profil",
      unit: "szt.",
    });
  });

  it("wymaga kategorii (uuid), jednostki ≤ 20 znaków, nazwy ≤ 200", () => {
    expect(createMaterialSchema.safeParse({ ...valid, category_id: "abc" }).success).toBe(false);
    expect(createMaterialSchema.safeParse({ ...valid, unit: "x".repeat(21) }).success).toBe(false);
    expect(createMaterialSchema.safeParse({ ...valid, unit: " " }).success).toBe(false);
    expect(createMaterialSchema.safeParse({ ...valid, name: "x".repeat(201) }).success).toBe(false);
    expect(createMaterialSchema.safeParse({ ...valid, name: "" }).success).toBe(false);
  });

  it("dostawca domyślny: uuid albo null", () => {
    expect(createMaterialSchema.safeParse({ ...valid, default_supplier_id: UUID2 }).success).toBe(true);
    expect(createMaterialSchema.safeParse({ ...valid, default_supplier_id: null }).success).toBe(true);
    expect(createMaterialSchema.safeParse({ ...valid, default_supplier_id: "x" }).success).toBe(false);
  });

  it(".strict(): odrzuca pola spoza schematu (created_by, id, active przy tworzeniu)", () => {
    for (const extra of [{ created_by: UUID }, { id: UUID }, { active: false }, { updated_at: "x" }]) {
      expect(createMaterialSchema.safeParse({ ...valid, ...extra }).success).toBe(false);
    }
  });

  it("aktualizacja: częściowa, wymaga co najmniej jednego pola, kod normalizowany", () => {
    expect(updateMaterialSchema.safeParse({}).success).toBe(false);
    expect(updateMaterialSchema.parse({ code: " ab " })).toEqual({ code: "AB" });
    expect(updateMaterialSchema.parse({ active: false })).toEqual({ active: false });
    expect(updateMaterialSchema.parse({ default_supplier_id: null })).toEqual({ default_supplier_id: null });
    expect(updateMaterialSchema.safeParse({ created_by: UUID }).success).toBe(false);
  });
});

describe("parametry listy materiałów", () => {
  it("domyślne wartości", () => {
    expect(listMaterialsQuerySchema.parse({})).toEqual({ includeInactive: false, inStock: false, page: 1, pageSize: 25 });
  });

  it("pageSize max 100, page ≥ 1, categoryId uuid, includeInactive", () => {
    expect(listMaterialsQuerySchema.safeParse({ pageSize: "101" }).success).toBe(false);
    expect(listMaterialsQuerySchema.safeParse({ pageSize: "0" }).success).toBe(false);
    expect(listMaterialsQuerySchema.safeParse({ page: "0" }).success).toBe(false);
    expect(listMaterialsQuerySchema.safeParse({ page: "abc" }).success).toBe(false);
    expect(listMaterialsQuerySchema.safeParse({ categoryId: "x" }).success).toBe(false);
    expect(listMaterialsQuerySchema.parse({ pageSize: "100", includeInactive: "true", q: " ab " })).toMatchObject({
      pageSize: 100,
      includeInactive: true,
      q: "ab",
    });
    expect(listMaterialsQuerySchema.safeParse({ includeInactive: "tak" }).success).toBe(false);
  });

  it("q: max 100 znaków, pusta → undefined", () => {
    expect(listMaterialsQuerySchema.safeParse({ q: "x".repeat(101) }).success).toBe(false);
    expect(listMaterialsQuerySchema.parse({ q: "   " }).q).toBeUndefined();
  });
});

describe("escapowanie frazy wyszukiwania", () => {
  it("%, _ i \\ są traktowane dosłownie", () => {
    expect(likeContains("100%")).toBe("%100\\%%");
    expect(likeContains("a_b")).toBe("%a\\_b%");
    expect(likeContains("a\\b")).toBe("%a\\\\b%");
  });

  it("* nie jest wildcardem PostgREST", () => {
    expect(likeContains("a*b")).toBe("%a_b%");
  });

  it("wartość do .or() jest w cudzysłowie, a \" i \\ escapowane — przecinki/nawiasy nie rozbijają filtra", () => {
    expect(buildIlikeContainsValue("a,b)(c")).toBe('"%a,b)(c%"');
    expect(buildIlikeContainsValue('x"y')).toBe('"%x\\"y%"');
    // \ w LIKE (\\) i potem escape dla PostgREST (\\\\)
    expect(buildIlikeContainsValue("a\\b")).toBe('"%a\\\\\\\\b%"');
    const injection = buildIlikeContainsValue('x",id.eq.1,code.ilike."');
    expect(injection.startsWith('"')).toBe(true);
    // wszystkie cudzysłowy wewnątrz są poprzedzone backslashem
    expect(injection.slice(1, -1).replace(/\\./g, "")).not.toContain('"');
  });
});
