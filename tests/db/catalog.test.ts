import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMaterial, listMaterials, listSuppliers, updateMaterial } from "@/server/catalog";
import {
  adminClient,
  anonClient,
  createTestUser,
  deleteAllTestUsers,
  signIn,
  type TestUser,
} from "./helpers";

// Testy RLS i reguł kartotek na bazie dev. Dane testowe mają prefiks TEST-<runId>- (unikalny na przebieg)
// i są sprzątane kluczem secret (authenticated nie ma DELETE) — wyłącznie własny runId.

const admin = adminClient();
const RUN = randomBytes(4).toString("hex").toUpperCase();
const P = `TEST-${RUN}`;

let tAdmin: TestUser;
let tBiuro: TestUser;
let tProdukcja: TestUser;
let tInactive: TestUser;
let asAdmin: SupabaseClient;
let asBiuro: SupabaseClient;
let asProdukcja: SupabaseClient;
let asInactive: SupabaseClient;
const anon = anonClient();

let categoryId: string;
let inactiveCategoryId: string;
let supplierId: string;
let inactiveSupplierId: string;
let materialId: string;

async function cleanupCatalog() {
  await admin.from("materials").delete().like("code", `${P}-%`);
  await admin.from("suppliers").delete().like("name", `${P}-%`);
  await admin.from("material_categories").delete().like("name", `${P}-%`);
}

beforeAll(async () => {
  await deleteAllTestUsers(admin);
  tAdmin = await createTestUser(admin, "ADMIN");
  tBiuro = await createTestUser(admin, "BIURO");
  tProdukcja = await createTestUser(admin, "PRODUKCJA");
  tInactive = await createTestUser(admin, "BIURO", "nieaktywny");
  [asAdmin, asBiuro, asProdukcja, asInactive] = await Promise.all([
    signIn(tAdmin),
    signIn(tBiuro),
    signIn(tProdukcja),
    signIn(tInactive),
  ]);
  // Dezaktywacja po zalogowaniu: JWT nadal ważny, ale profil nieaktywny (jak w produkcji).
  const { error } = await admin.from("profiles").update({ active: false }).eq("id", tInactive.id);
  if (error) throw error;

  const cat = await asAdmin.from("material_categories").insert({ name: `${P}-kat` }).select().single();
  const catOff = await asAdmin
    .from("material_categories")
    .insert({ name: `${P}-kat-off`, active: false })
    .select()
    .single();
  const sup = await asAdmin.from("suppliers").insert({ name: `${P}-dost` }).select().single();
  const supOff = await asAdmin.from("suppliers").insert({ name: `${P}-dost-off`, active: false }).select().single();
  for (const r of [cat, catOff, sup, supOff]) if (r.error) throw r.error;
  categoryId = cat.data!.id;
  inactiveCategoryId = catOff.data!.id;
  supplierId = sup.data!.id;
  inactiveSupplierId = supOff.data!.id;

  const mat = await asAdmin
    .from("materials")
    .insert({ code: `${P}-M1`, name: "Profil testowy", category_id: categoryId, unit: "sztanga" })
    .select()
    .single();
  if (mat.error) throw mat.error;
  materialId = mat.data.id;
});

afterAll(async () => {
  await cleanupCatalog();
  await deleteAllTestUsers(admin);
});

describe("seed", () => {
  it("kategorie MVP istnieją", async () => {
    const { data, error } = await asProdukcja.from("material_categories").select("name");
    expect(error).toBeNull();
    const names = (data ?? []).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["Profile", "Akcesoria", "Uszczelki", "Chemia"]));
  });
});

describe("RLS — odczyt", () => {
  const tables = ["material_categories", "suppliers", "materials"] as const;

  it.each(tables)("anon nie ma dostępu do %s", async (table) => {
    const { data, error } = await anon.from(table).select("id").limit(1);
    // anon nie ma GRANT → PostgREST zwraca 42501 (permission denied), bez danych
    expect(error?.code).toBe("42501");
    expect(data).toBeNull();
  });

  it.each(tables)("nieaktywny użytkownik nie widzi nic w %s", async (table) => {
    const { data, error } = await asInactive.from(table).select("id");
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it.each([
    ["ADMIN", () => asAdmin],
    ["BIURO", () => asBiuro],
    ["PRODUKCJA", () => asProdukcja],
  ])("%s widzi kartoteki", async (_role, session) => {
    for (const table of tables) {
      const { data, error } = await session().from(table).select("id");
      expect(error).toBeNull();
      expect((data ?? []).length).toBeGreaterThan(0);
    }
  });
});

describe("RLS — zapis wg tabeli uprawnień", () => {
  it("kategorie: tylko ADMIN", async () => {
    for (const [session, ok] of [
      [asBiuro, false],
      [asProdukcja, false],
      [asInactive, false],
    ] as const) {
      const ins = await session.from("material_categories").insert({ name: `${P}-x-${Math.random()}` });
      expect(ins.error?.code, "insert").toBe("42501");
      expect(ok).toBe(false);
      const upd = await session.from("material_categories").update({ name: `${P}-hack` }).eq("id", categoryId).select();
      expect(upd.data ?? []).toHaveLength(0);
    }
    const okRes = await asAdmin.from("material_categories").update({ active: true }).eq("id", categoryId).select();
    expect(okRes.data).toHaveLength(1);
  });

  it("dostawcy: ADMIN i BIURO tak, PRODUKCJA i nieaktywny nie", async () => {
    const biuro = await asBiuro.from("suppliers").insert({ name: `${P}-biuro` }).select().single();
    expect(biuro.error).toBeNull();
    const upd = await asBiuro.from("suppliers").update({ phone: "123" }).eq("id", supplierId).select();
    expect(upd.data).toHaveLength(1);

    for (const session of [asProdukcja, asInactive]) {
      const ins = await session.from("suppliers").insert({ name: `${P}-zly-${Math.random()}` });
      expect(ins.error?.code).toBe("42501");
      const u = await session.from("suppliers").update({ phone: "999" }).eq("id", supplierId).select();
      expect(u.data ?? []).toHaveLength(0);
    }
  });

  it("materiały: tylko ADMIN", async () => {
    for (const session of [asBiuro, asProdukcja, asInactive]) {
      const ins = await session
        .from("materials")
        .insert({ code: `${P}-ZLY`, name: "x", category_id: categoryId, unit: "szt." });
      expect(ins.error?.code).toBe("42501");
      const u = await session.from("materials").update({ name: "hack" }).eq("id", materialId).select();
      expect(u.data ?? []).toHaveLength(0);
    }
    const { data } = await admin.from("materials").select("name").eq("id", materialId).single();
    expect(data?.name).toBe("Profil testowy");
  });

  it("DELETE niemożliwy dla nikogo (authenticated)", async () => {
    for (const session of [asAdmin, asBiuro, asProdukcja]) {
      for (const [table, id] of [
        ["materials", materialId],
        ["suppliers", supplierId],
        ["material_categories", categoryId],
      ] as const) {
        const res = await session.from(table).delete().eq("id", id).select();
        expect(res.error?.code).toBe("42501");
      }
    }
    const { data } = await admin.from("materials").select("id").eq("id", materialId);
    expect(data).toHaveLength(1);
  });
});

describe("unikalność i normalizacja", () => {
  it("INSERT materiału przez BIURO/PRODUKCJA: 42501 z triggera (przed RLS i blokadami FOR SHARE)", async () => {
    for (const session of [asBiuro, asProdukcja]) {
      const res = await session
        .from("materials")
        .insert({ code: `${P}-TRG`, name: "x", category_id: categoryId, unit: "szt." });
      expect(res.error?.code).toBe("42501");
      expect(res.error?.message).toBe("Brak uprawnień do zapisu materiałów");
    }
  });

  it("równoległe inserty tego samego kodu: jeden sukces, reszta 23505", async () => {
    const code = `${P}-RACE`;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        asAdmin
          .from("materials")
          .insert({ code, name: `Wyścig ${i}`, category_id: categoryId, unit: "szt." })
          .select("id"),
      ),
    );
    const ok = results.filter((r) => !r.error);
    const failed = results.filter((r) => r.error);
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(5);
    for (const r of failed) expect(r.error?.code).toBe("23505");
    const { data } = await admin.from("materials").select("id").eq("code", code);
    expect(data).toHaveLength(1);
  });

  it("kod materiału: UPPERCASE, trim, unikalny bez względu na wielkość liter", async () => {
    const lower = `${P}-m1`.toLowerCase();
    const dup = await asAdmin
      .from("materials")
      .insert({ code: `  ${lower} `, name: "Duplikat", category_id: categoryId, unit: "szt." });
    expect(dup.error?.code).toBe("23505");

    const ok = await asAdmin
      .from("materials")
      .insert({ code: `${P}-abc.1/2_x`.toLowerCase(), name: "  Nowy  ", category_id: categoryId, unit: " szt. " })
      .select()
      .single();
    expect(ok.error).toBeNull();
    expect(ok.data).toMatchObject({ code: `${P}-ABC.1/2_X`, name: "Nowy", unit: "szt." });
  });

  it("kod ze spacjami wewnątrz: normalizacja i unikalność niezależna od liczby spacji", async () => {
    const first = await asAdmin
      .from("materials")
      .insert({ code: `  ${P.toLowerCase()}-k518   ral9016 `, name: "Ze spacją", category_id: categoryId, unit: "szt." })
      .select()
      .single();
    expect(first.error).toBeNull();
    expect(first.data?.code).toBe(`${P}-K518 RAL9016`);

    const dup = await asAdmin
      .from("materials")
      .insert({ code: `${P}-k518 ral9016`, name: "Dup", category_id: categoryId, unit: "szt." });
    expect(dup.error?.code).toBe("23505");
  });

  it.each(["", "   ", "ĄŚ", "A".repeat(51), `${"A".repeat(25)} ${"B".repeat(25)}`, "A;B", "A,B"])(
    "zły kod %j odrzucony",
    async (code) => {
      const res = await asAdmin
        .from("materials")
        .insert({ code, name: "x", category_id: categoryId, unit: "szt." });
      expect(res.error?.code).toBe("23514");
    },
  );

  it("nazwa kategorii i dostawcy: unikalna bez względu na wielkość liter", async () => {
    const c = await asAdmin.from("material_categories").insert({ name: `${P}-KAT`.toLowerCase() });
    expect(c.error?.code).toBe("23505");
    const s = await asAdmin.from("suppliers").insert({ name: ` ${P}-DOST ` });
    expect(s.error?.code).toBe("23505");
  });

  it("puste nazwy i jednostki odrzucone; limity długości", async () => {
    expect((await asAdmin.from("material_categories").insert({ name: "   " })).error?.code).toBe("23514");
    expect((await asAdmin.from("material_categories").insert({ name: "x".repeat(81) })).error?.code).toBe("23514");
    expect((await asAdmin.from("suppliers").insert({ name: "x".repeat(201) })).error?.code).toBe("23514");
    expect(
      (await asAdmin.from("materials").insert({ code: `${P}-U`, name: "x", category_id: categoryId, unit: " " })).error
        ?.code,
    ).toBe("23514");
    expect(
      (
        await asAdmin
          .from("materials")
          .insert({ code: `${P}-U`, name: "x", category_id: categoryId, unit: "x".repeat(21) })
      ).error?.code,
    ).toBe("23514");
  });

  it("puste pola opcjonalne dostawcy zapisują się jako NULL", async () => {
    const { data, error } = await asAdmin
      .from("suppliers")
      .insert({ name: `${P}-null`, phone: "  ", email: "", notes: " " })
      .select()
      .single();
    expect(error).toBeNull();
    expect(data).toMatchObject({ phone: null, email: null, notes: null });
  });
});

describe("audyt (created_by / updated_by)", () => {
  it("klient nie może podrobić created_by/updated_by/created_at", async () => {
    const { data, error } = await asAdmin
      .from("materials")
      .insert({
        code: `${P}-AUD`,
        name: "Audyt",
        category_id: categoryId,
        unit: "szt.",
        created_by: tBiuro.id,
        updated_by: tBiuro.id,
        created_at: "2000-01-01T00:00:00Z",
      })
      .select()
      .single();
    expect(error).toBeNull();
    expect(data?.created_by).toBe(tAdmin.id);
    expect(data?.updated_by).toBe(tAdmin.id);
    expect(new Date(data!.created_at).getFullYear()).toBeGreaterThan(2020);

    const upd = await asAdmin
      .from("materials")
      .update({ created_by: tBiuro.id, created_at: "2000-01-01T00:00:00Z", updated_by: tBiuro.id, name: "Audyt 2" })
      .eq("id", data!.id)
      .select()
      .single();
    expect(upd.error).toBeNull();
    expect(upd.data?.created_by).toBe(tAdmin.id);
    expect(upd.data?.updated_by).toBe(tAdmin.id);
    expect(upd.data?.created_at).toBe(data?.created_at);
    expect(new Date(upd.data!.updated_at).getTime()).toBeGreaterThanOrEqual(new Date(data!.updated_at).getTime());
  });

  it("updated_by wskazuje ostatniego edytującego (BIURO edytuje dostawcę)", async () => {
    const { data } = await asBiuro.from("suppliers").update({ notes: "zmiana" }).eq("id", supplierId).select().single();
    expect(data?.updated_by).toBe(tBiuro.id);
  });

  it("nie można zmienić id", async () => {
    const res = await asAdmin
      .from("materials")
      .update({ id: "00000000-0000-4000-8000-000000000001" })
      .eq("id", materialId)
      .select();
    expect(res.error).not.toBeNull();
  });
});

describe("nieaktywna kategoria / dostawca", () => {
  it("nie można utworzyć materiału w nieaktywnej kategorii ani z nieaktywnym dostawcą", async () => {
    const a = await asAdmin
      .from("materials")
      .insert({ code: `${P}-N1`, name: "x", category_id: inactiveCategoryId, unit: "szt." });
    expect(a.error?.code).toBe("P0001");
    expect(a.error?.hint).toBe("INACTIVE_CATEGORY");

    const b = await asAdmin.from("materials").insert({
      code: `${P}-N2`,
      name: "x",
      category_id: categoryId,
      unit: "szt.",
      default_supplier_id: inactiveSupplierId,
    });
    expect(b.error?.code).toBe("P0001");
    expect(b.error?.hint).toBe("INACTIVE_SUPPLIER");
  });

  it("nie można przepiąć materiału na nieaktywną kategorię / dostawcę", async () => {
    const a = await asAdmin.from("materials").update({ category_id: inactiveCategoryId }).eq("id", materialId);
    expect(a.error?.hint).toBe("INACTIVE_CATEGORY");
    const b = await asAdmin.from("materials").update({ default_supplier_id: inactiveSupplierId }).eq("id", materialId);
    expect(b.error?.hint).toBe("INACTIVE_SUPPLIER");
  });

  it("nieistniejące id → naruszenie klucza obcego", async () => {
    const missing = "00000000-0000-4000-8000-0000000000aa";
    const a = await asAdmin
      .from("materials")
      .insert({ code: `${P}-N3`, name: "x", category_id: missing, unit: "szt." });
    expect(a.error?.code).toBe("23503");
    const b = await asAdmin.from("materials").insert({
      code: `${P}-N4`,
      name: "x",
      category_id: categoryId,
      unit: "szt.",
      default_supplier_id: missing,
    });
    expect(b.error?.code).toBe("23503");
  });

  it("dezaktywacja kategorii nie blokuje edycji istniejącego materiału", async () => {
    const cat = await asAdmin.from("material_categories").insert({ name: `${P}-kat2` }).select().single();
    const mat = await asAdmin
      .from("materials")
      .insert({ code: `${P}-K2`, name: "x", category_id: cat.data!.id, unit: "szt." })
      .select()
      .single();
    expect(mat.error).toBeNull();
    await asAdmin.from("material_categories").update({ active: false }).eq("id", cat.data!.id);
    const upd = await asAdmin.from("materials").update({ name: "y", active: false }).eq("id", mat.data!.id).select();
    expect(upd.error).toBeNull();
    expect(upd.data).toHaveLength(1);
  });
});

describe("serwis katalogu (klient użytkownika)", () => {
  it("createMaterial/updateMaterial: 409 przy duplikacie, 400 przy nieaktywnej kategorii", async () => {
    const dup = await createMaterial(asAdmin, {
      code: `${P}-M1`,
      name: "x",
      category_id: categoryId,
      unit: "szt.",
    });
    expect(dup).toMatchObject({ ok: false, error: { status: 409, code: "CODE_TAKEN" } });

    const inactive = await updateMaterial(asAdmin, materialId, { category_id: inactiveCategoryId });
    expect(inactive).toMatchObject({ ok: false, error: { status: 400, code: "INACTIVE_CATEGORY" } });

    const forbidden = await createMaterial(asBiuro, {
      code: `${P}-F`,
      name: "x",
      category_id: categoryId,
      unit: "szt.",
    });
    expect(forbidden).toMatchObject({ ok: false, error: { status: 403 } });

    const notFound = await updateMaterial(asAdmin, "00000000-0000-4000-8000-0000000000bb", { name: "x" });
    expect(notFound).toMatchObject({ ok: false, error: { status: 404 } });
  });

  it("listMaterials: wyszukiwanie po kodzie i nazwie, paginacja, filtr nieaktywnych", async () => {
    const base = { includeInactive: false, page: 1, pageSize: 25 };
    const byCode = await listMaterials(asProdukcja, { ...base, q: `${P}-m1`.toLowerCase() });
    expect(byCode.ok && byCode.data.items.map((m) => m.code)).toEqual([`${P}-M1`]);

    const byName = await listMaterials(asBiuro, { ...base, q: "profil testowy" });
    expect(byName.ok && byName.data.items.some((m) => m.id === materialId)).toBe(true);
    if (byName.ok) expect(byName.data.items[0]).toMatchObject({ categoryName: `${P}-kat` });

    const page = await listMaterials(asAdmin, { ...base, q: P, pageSize: 1 });
    expect(page.ok && page.data.items).toHaveLength(1);
    if (page.ok) expect(page.data.total).toBeGreaterThan(1);

    const beyond = await listMaterials(asAdmin, { ...base, q: P, page: 9999 });
    expect(beyond.ok && beyond.data.items).toHaveLength(0);
    if (beyond.ok) expect(beyond.data.total).toBeGreaterThan(1); // prawdziwe total mimo strony poza zakresem

    const inactive = await listMaterials(asAdmin, { ...base, q: `${P}-K2` });
    expect(inactive.ok && inactive.data.items).toHaveLength(0);
    const withInactive = await listMaterials(asAdmin, { ...base, q: `${P}-K2`, includeInactive: true });
    expect(withInactive.ok && withInactive.data.items).toHaveLength(1);
  });

  it.each(['%', "_", "a,b", "x)(y", '"cudzysłów"', "\\", "a.b:c", "or(", "q\" ,id.eq.1"])(
    "q=%j nie psuje filtra ani nie działa jak wzorzec/wstrzyknięcie",
    async (q) => {
      const res = await listMaterials(asAdmin, { includeInactive: true, page: 1, pageSize: 100, q });
      expect(res.ok).toBe(true);
      if (res.ok) {
        // Dosłowne dopasowanie: każdy wynik zawiera frazę w kodzie lub nazwie (bez rozróżniania wielkości liter).
        for (const m of res.data.items) {
          const hay = `${m.code}\n${m.name}`.toLowerCase();
          // '*' jest zamieniane na jednoznakowy wildcard (alias % w PostgREST) — wynik ma mieć jakikolwiek znak.
          expect(q === "*" ? hay.length > 0 : hay.includes(q.toLowerCase())).toBe(true);
        }
      }
    },
  );

  it("q='*' to jednoznakowy wildcard, nie 'dowolny ciąg'", async () => {
    const mk = (suffix: string, name: string) =>
      createMaterial(asAdmin, { code: `${P}-STAR${suffix}`, name, category_id: categoryId, unit: "szt." });
    expect((await mk("1", "gwiazda a*b koniec")).ok).toBe(true);
    expect((await mk("2", "gwiazda azzzb koniec")).ok).toBe(true);
    const res = await listMaterials(asAdmin, { includeInactive: false, page: 1, pageSize: 100, q: "a*b koniec" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const codes = res.data.items.map((m) => m.code);
      expect(codes).toContain(`${P}-STAR1`);
      expect(codes).not.toContain(`${P}-STAR2`);
    }
  });

  it("q ze znakami specjalnymi znajduje dosłowny kod", async () => {
    const created = await createMaterial(asAdmin, {
      code: `${P}-PCT_1`,
      name: "Test 100% 'a,b'",
      category_id: categoryId,
      unit: "szt.",
    });
    expect(created.ok).toBe(true);
    for (const q of ["100%", "pct_1", "'a,b'"]) {
      const res = await listMaterials(asAdmin, { includeInactive: false, page: 1, pageSize: 25, q });
      expect(res.ok && res.data.items.map((m) => m.code)).toContain(`${P}-PCT_1`);
    }
    // '%' i '_' nie działają jako wildcard: "pct_1" nie dopasuje się jako "pct" + dowolny znak + "1" do innych kodów
    const wildcard = await listMaterials(asAdmin, { includeInactive: false, page: 1, pageSize: 25, q: `${P}-PCT%1` });
    expect(wildcard.ok && wildcard.data.items).toHaveLength(0);
  });

  it("listSuppliers: wyszukiwanie dosłowne po nazwie", async () => {
    const res = await listSuppliers(asBiuro, { q: `${P}-dost`, includeInactive: false });
    expect(res.ok && res.data.map((s) => s.name)).toContain(`${P}-dost`);
    const none = await listSuppliers(asBiuro, { q: "%", includeInactive: false });
    expect(none.ok && none.data.every((s) => s.name.includes("%"))).toBe(true);
  });
});
