import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMaterial, getMaterial, updateMaterial } from "@/server/catalog";
import { getDashboardStats, getMaterialTotal, listBelowMinimum, listMaterialTotals } from "@/server/overview";
import { listStock } from "@/server/stock";
import { adminClient, anonClient, createTestUser, deleteAllTestUsers, signIn, type TestUser } from "./helpers";

// Etap 7 (ADR 012): stan minimalny (CHECK/trigger/uprawnienia), widoki sum per materiał, „poniżej minimum”,
// statystyki dashboardu, eksport. Dane testowe: materiały is_test = true (klucz secret) → purge_test_stock;
// kartoteki i konta z prefiksem TEST-<runId>-/test-, sprzątane na końcu.

const admin = adminClient();
const anon = anonClient();
const dbUrl = process.env.SUPABASE_DB_URL;
let sql: postgres.Sql;
const extraLocations: string[] = [];
const RUN = randomBytes(4).toString("hex").toUpperCase();
const P = `TEST-${RUN}`;

let tAdmin: TestUser;
let tBiuro: TestUser;
let tProd: TestUser;
let asAdmin: SupabaseClient;
let asBiuro: SupabaseClient;
let asProd: SupabaseClient;

const ids = { category: "", category2: "", category3: "", category4: "", numCode: "", numLocCode: "", mR: "", mA: "", mB: "", mC: "", mD: "", mE: "", l1: "", l2: "" };
const testMaterials: string[] = [];

async function material(code: string, unit: string, extra: Record<string, unknown> = {}, category = ids.category) {
  const { data, error } = await admin
    .from("materials")
    .insert({ code: `${P}-${code}`, name: `Materiał ${code}`, unit, category_id: category, is_test: true, ...extra })
    .select("id")
    .single();
  if (error) throw error;
  testMaterials.push(data.id as string);
  return data.id as string;
}

async function location(code: string) {
  const { data, error } = await asAdmin.from("locations").insert({ code: `${P}-${code}` }).select("id").single();
  if (error) throw error;
  return data.id as string;
}

async function receive(materialId: string, locationId: string, quantity: number) {
  const { error } = await asProd.rpc("stock_receipt", {
    p_client_request_id: randomUUID(),
    p_location_id: locationId,
    p_material_id: materialId,
    p_quantity: quantity,
  });
  if (error) throw error;
}

async function minOf(id: string) {
  const { data, error } = await admin.from("materials").select("min_quantity").eq("id", id).single();
  if (error) throw error;
  return data.min_quantity === null ? null : Number(data.min_quantity);
}

beforeAll(async () => {
  if (!dbUrl) throw new Error("Brak SUPABASE_DB_URL w .env.scripts");
  sql = postgres(dbUrl, { max: 2, prepare: false, onnotice: () => {} });
  await deleteAllTestUsers(admin);
  tAdmin = await createTestUser(admin, "ADMIN");
  tBiuro = await createTestUser(admin, "BIURO");
  tProd = await createTestUser(admin, "PRODUKCJA");
  [asAdmin, asBiuro, asProd] = await Promise.all([signIn(tAdmin), signIn(tBiuro), signIn(tProd)]);

  const cat = await asAdmin.from("material_categories").insert({ name: `${P}-kat` }).select("id").single();
  const cat2 = await asAdmin.from("material_categories").insert({ name: `${P}-kat2` }).select("id").single();
  const cat3 = await asAdmin.from("material_categories").insert({ name: `${P}-kat3` }).select("id").single();
  if (cat.error || cat2.error || cat3.error) throw cat.error ?? cat2.error ?? cat3.error;
  ids.category = cat.data.id;
  ids.category2 = cat2.data.id;
  ids.category3 = cat3.data.id; // materiały pomocnicze testów kolumny (nie wchodzą do list kategorii 1 i 2)

  ids.mA = await material("A", "szt.", { min_quantity: 10 });
  ids.mB = await material("B", "mb", { min_quantity: 2.5 });
  ids.mC = await material("C", "szt."); // bez minimum
  ids.mD = await material("D", "szt.", { min_quantity: 5 }); // zostanie dezaktywowany
  ids.mE = await material("E", "mb", { min_quantity: 2.5 }, ids.category2);
  const cat4 = await asAdmin.from("material_categories").insert({ name: `${P}-kat4` }).select("id").single();
  if (cat4.error) throw cat4.error;
  ids.category4 = cat4.data.id;
  ids.l1 = await location("L1");
  ids.l2 = await location("L2");

  ids.mR = await material("R", "szt.", {}, ids.category3);
  // Materiały do testu eksportu (kategoria 4): cytowanie, injection i kod-liczba (usuwane po id).
  const digits = () => String(Math.floor(Math.random() * 9_000_000) + 1_000_000);
  ids.numCode = "0" + digits();
  ids.numLocCode = "0" + digits();
  const mNum = await admin
    .from("materials")
    .insert({ code: ids.numCode, name: "Cyfry", unit: "mb", category_id: ids.category4, is_test: true })
    .select("id")
    .single();
  if (mNum.error) throw mNum.error;
  testMaterials.push(mNum.data.id as string);
  const lNum = await asAdmin.from("locations").insert({ code: ids.numLocCode }).select("id").single();
  if (lNum.error) throw lNum.error;
  extraLocations.push(lNum.data.id as string);
  const x1 = await material("X1", "szt.", { name: "=cmd|' /C calc'!A0" }, ids.category4);
  const x2 = await material("X2", "szt.", { name: 'Profil; "biały"\nlinia2' }, ids.category4);
  const x3 = await material("X3", "szt.", { name: "-2+3" }, ids.category4);
  await receive(mNum.data.id as string, lNum.data.id as string, 2.5);
  await receive(x1, ids.l1, 1);
  await receive(x2, ids.l1, 2);
  await receive(x3, ids.l1, 3);

  await receive(ids.mA, ids.l1, 4);
  await receive(ids.mA, ids.l2, 3); // suma 7 < 10
  await receive(ids.mC, ids.l1, 100);
  const off = await asAdmin.from("materials").update({ active: false }).eq("id", ids.mD);
  if (off.error) throw off.error;
});

afterAll(async () => {
  try {
    const purge = await admin.rpc("purge_test_stock", { p_material_ids: testMaterials });
    if (purge.error) console.warn("purge_test_stock:", purge.error.message);
    await admin.from("materials").delete().in("id", testMaterials);
    await admin.from("materials").delete().like("code", `${P}-%`);
    if (extraLocations.length) await admin.from("locations").delete().in("id", extraLocations);
    await admin.from("locations").delete().like("code", `${P}-%`);
    await admin.from("material_categories").delete().like("name", `${P}-%`);
  } finally {
    await sql?.end();
    await deleteAllTestUsers(admin);
  }
});

// ---------------------------------------------------------------------------
describe("materials.min_quantity — CHECK, trigger, uprawnienia", () => {
  it("zapis i odczyt: NULL = brak alarmu, ułamek dla mb OK, DTO", async () => {
    expect(await minOf(ids.mC)).toBeNull();
    expect(await minOf(ids.mB)).toBe(2.5);
    const dto = await getMaterial(asBiuro, ids.mB);
    expect(dto.ok && dto.data.minQuantity).toBe(2.5);
    const none = await getMaterial(asBiuro, ids.mC);
    expect(none.ok && none.data.minQuantity).toBeNull();
  });

  it("ujemne → naruszenie CHECK (23514), nawet kluczem secret", async () => {
    const upd = await admin.from("materials").update({ min_quantity: -1 }).eq("id", ids.mA);
    expect(upd.error?.code).toBe("23514");
    const ins = await admin
      .from("materials")
      .insert({ code: `${P}-NEG`, name: "x", unit: "mb", category_id: ids.category, min_quantity: -0.5 });
    expect(ins.error?.code).toBe("23514");
    expect(await minOf(ids.mA)).toBe(10);
  });

  it("ułamek dla materiału bez ułamków (szt.) → MIN_NOT_INTEGER (UPDATE i INSERT)", async () => {
    const upd = await asAdmin.from("materials").update({ min_quantity: 2.5 }).eq("id", ids.mA);
    expect(upd.error?.code).toBe("P0001");
    expect(upd.error?.hint).toBe("MIN_NOT_INTEGER");
    expect(await minOf(ids.mA)).toBe(10);
    const ins = await admin
      .from("materials")
      .insert({ code: `${P}-FRAC`, name: "x", unit: "szt.", category_id: ids.category, min_quantity: 1.5 });
    expect(ins.error?.hint).toBe("MIN_NOT_INTEGER");
    // serwis mapuje błąd na 400
    const svc = await updateMaterial(asAdmin, ids.mA, { min_quantity: 2.5 });
    expect(!svc.ok && svc.error.status).toBe(400);
    expect(!svc.ok && svc.error.code).toBe("MIN_NOT_INTEGER");
  });

  it("wyłączenie ułamków przy ułamkowym minimum → MIN_NOT_INTEGER; całkowite minimum przechodzi", async () => {
    const e = await material("FLIP", "mb", { min_quantity: 2.5 }, ids.category3);
    const bad = await asAdmin.from("materials").update({ allows_fraction: false }).eq("id", e);
    expect(bad.error?.hint).toBe("MIN_NOT_INTEGER");
    const fix = await asAdmin.from("materials").update({ allows_fraction: false, min_quantity: 3 }).eq("id", e);
    expect(fix.error).toBeNull();
    expect(await minOf(e)).toBe(3);
  });

  it("czyszczenie minimum (null) działa; ADMIN może ustawić 0 i liczbę całkowitą", async () => {
    const e = await material("CLR", "szt.", { min_quantity: 4 }, ids.category3);
    const clear = await updateMaterial(asAdmin, e, { min_quantity: null });
    expect(clear.ok && clear.data.minQuantity).toBeNull();
    const zero = await updateMaterial(asAdmin, e, { min_quantity: 0 });
    expect(zero.ok && zero.data.minQuantity).toBe(0);
    const created = await createMaterial(asAdmin, {
      code: `${P}-CRT`,
      name: "Z minimum",
      category_id: ids.category3,
      unit: "szt.",
      min_quantity: 6,
    });
    expect(created.ok && created.data.minQuantity).toBe(6);
  });

  it("BIURO i PRODUKCJA nie zmienią min_quantity (brak zapisu / 42501), anon odrzucony", async () => {
    for (const session of [asBiuro, asProd]) {
      const upd = await session.from("materials").update({ min_quantity: 99 }).eq("id", ids.mA).select();
      // RLS odfiltrowuje wiersz (0 zmienionych) albo trigger odrzuca (42501) — w obu przypadkach bez zmiany.
      if (upd.error) expect(upd.error.code).toBe("42501");
      else expect(upd.data).toHaveLength(0);
    }
    const ins = await asBiuro
      .from("materials")
      .insert({ code: `${P}-BIURO`, name: "x", unit: "szt.", category_id: ids.category, min_quantity: 1 });
    expect(ins.error?.code).toBe("42501");
    const a = await anon.from("materials").update({ min_quantity: 99 }).eq("id", ids.mA);
    expect(a.error).not.toBeNull();
    expect(await minOf(ids.mA)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
describe("v_material_stock i „poniżej minimum”", () => {
  it("suma po lokalizacjach, liczba lokalizacji, brak do minimum", async () => {
    const r = await getMaterialTotal(asBiuro, ids.mA);
    expect(r.ok).toBe(true);
    if (!r.ok || !r.data) return;
    expect(r.data.totalQuantity).toBe(7);
    expect(r.data.locationCount).toBe(2);
    expect(r.data.minQuantity).toBe(10);
    expect(r.data.belowMinimum).toBe(true);
    expect(r.data.shortage).toBe(3);
  });

  it("stan >= minimum → nie jest poniżej; bez minimum (null) → nigdy; stan 0 + minimum → poniżej", async () => {
    const c = await getMaterialTotal(asBiuro, ids.mC);
    expect(c.ok && c.data?.belowMinimum).toBe(false);
    expect(c.ok && c.data?.shortage).toBe(0);
    const b = await getMaterialTotal(asBiuro, ids.mB);
    expect(b.ok && b.data?.totalQuantity).toBe(0);
    expect(b.ok && b.data?.belowMinimum).toBe(true);
    expect(b.ok && b.data?.shortage).toBe(2.5);
  });

  it("nieaktywny materiał z minimum jest pomijany", async () => {
    const d = await getMaterialTotal(asBiuro, ids.mD);
    expect(d.ok && d.data?.belowMinimum).toBe(false);
    const list = await listBelowMinimum(asBiuro, 500);
    expect(list.ok && list.data.some((m) => m.materialId === ids.mD)).toBe(false);
  });

  it("lista poniżej minimum: sortowanie po największym braku, zawiera A i B (nie C, nie D)", async () => {
    const list = await listBelowMinimum(asBiuro, 500);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const mine = list.data.filter((m) => [ids.mA, ids.mB, ids.mC, ids.mD].includes(m.materialId));
    expect(mine.map((m) => m.materialId)).toEqual([ids.mA, ids.mB]); // brak 3 > 2,5
    const shortages = list.data.map((m) => m.shortage);
    expect([...shortages].sort((x, y) => y - x)).toEqual(shortages);
  });

  it("dołożenie stanu zdejmuje flagę (7 + 5 = 12 >= 10)", async () => {
    await receive(ids.mA, ids.l1, 5);
    const a = await getMaterialTotal(asBiuro, ids.mA);
    expect(a.ok && a.data?.totalQuantity).toBe(12);
    expect(a.ok && a.data?.belowMinimum).toBe(false);
    await asAdmin.from("materials").update({ min_quantity: 20 }).eq("id", ids.mA); // wraca „poniżej”
    const again = await getMaterialTotal(asBiuro, ids.mA);
    expect(again.ok && again.data?.belowMinimum).toBe(true);
    expect(again.ok && again.data?.shortage).toBe(8);
    // Od tej chwili A ma minimum 20 (stan 12 → poniżej, brakuje 8).
    await asAdmin.from("materials").update({ min_quantity: 20 }).eq("id", ids.mA);
  });

  it("sumy per materiał zgodne z v_stock (po wszystkich materiałach testu)", async () => {
    const totals = await admin.from("v_material_stock").select("material_id, total_quantity").in("material_id", testMaterials);
    const rows = await admin.from("v_stock").select("material_id, quantity").in("material_id", testMaterials);
    expect(totals.error).toBeNull();
    expect(rows.error).toBeNull();
    const sums = new Map<string, number>();
    for (const r of rows.data ?? []) sums.set(r.material_id, (sums.get(r.material_id) ?? 0) + Number(r.quantity));
    for (const t of totals.data ?? []) expect(Number(t.total_quantity), t.material_id).toBe(sums.get(t.material_id) ?? 0);
  });

  it("v_stock.below_minimum zgodne z v_material_stock", async () => {
    const rows = await admin.from("v_stock").select("material_id, below_minimum").in("material_id", [ids.mA, ids.mC]);
    expect(rows.error).toBeNull();
    for (const r of rows.data ?? []) expect(r.below_minimum).toBe(r.material_id === ids.mA);
  });

  it("listMaterialTotals: widok domyślny (stan > 0 albo poniżej minimum), filtry, tryb allActive", async () => {
    const base = { page: 1, pageSize: 100, categoryId: ids.category, q: `${P}-` };
    const def = await listMaterialTotals(asBiuro, base);
    expect(def.ok && def.data.items.map((m) => m.materialId).sort()).toEqual([ids.mA, ids.mB, ids.mC].sort());
    const below = await listMaterialTotals(asBiuro, { ...base, belowMin: true });
    expect(below.ok && below.data.items.map((m) => m.materialId).sort()).toEqual([ids.mA, ids.mB].sort());
    expect(below.ok && below.data.total).toBe(2);
    const cat2 = await listMaterialTotals(asBiuro, { page: 1, pageSize: 100, categoryId: ids.category2, q: `${P}-` });
    expect(cat2.ok && cat2.data.items.map((m) => m.materialId)).toEqual([ids.mE]);
    const all = await listMaterialTotals(asProd, { page: 1, pageSize: 100, q: `${P}-`, allActive: true, categoryId: ids.category });
    // aktywne bez filtra stanu: A, B, C (D nieaktywny); PRODUKCJA też widzi stany
    expect(all.ok && all.data.items.map((m) => m.materialId).sort()).toEqual([ids.mA, ids.mB, ids.mC].sort());
    const paged = await listMaterialTotals(asBiuro, { page: 2, pageSize: 1, categoryId: ids.category, q: `${P}-` });
    expect(paged.ok && paged.data.total).toBe(3);
    expect(paged.ok && paged.data.items).toHaveLength(1);
    const beyond = await listMaterialTotals(asBiuro, { page: 50, pageSize: 100, categoryId: ids.category, q: `${P}-` });
    expect(beyond.ok && beyond.data.items).toHaveLength(0);
  });

  it("wyszukiwanie escapuje znaki LIKE: % nie działa jak wildcard", async () => {
    const r = await listMaterialTotals(asBiuro, { page: 1, pageSize: 10, q: "%" });
    expect(r.ok && r.data.items.every((m) => m.code.includes("%") || m.name.includes("%"))).toBe(true);
  });

  it("listStock: filtr kategorii i tylko poniżej minimum", async () => {
    const inCat = await listStock(asBiuro, { page: 1, pageSize: 100, categoryId: ids.category, q: `${P}-` });
    expect(inCat.ok && inCat.data.items.map((r) => r.materialId).sort()).toEqual([ids.mA, ids.mA, ids.mC].sort());
    await asAdmin.from("materials").update({ min_quantity: 50 }).eq("id", ids.mA);
    const below = await listStock(asBiuro, { page: 1, pageSize: 100, categoryId: ids.category, belowMin: true, q: `${P}-` });
    expect(below.ok && below.data.items.every((r) => r.materialId === ids.mA)).toBe(true);
    expect(below.ok && below.data.total).toBe(2);
    await asAdmin.from("materials").update({ min_quantity: 20 }).eq("id", ids.mA);
  });
});

// ---------------------------------------------------------------------------
describe("dashboard_stats", () => {
  it("ADMIN i BIURO: liczniki spójne z danymi; PRODUKCJA → 42501; anon odrzucony", async () => {
    for (const session of [asAdmin, asBiuro]) {
      const stats = await getDashboardStats(session);
      expect(stats.ok).toBe(true);
      if (!stats.ok) continue;
      const below = await admin.from("v_material_stock").select("material_id", { count: "exact", head: true }).eq("below_minimum", true);
      expect(stats.data.belowMinimum).toBe(below.count);
      const mats = await admin.from("materials").select("id", { count: "exact", head: true }).eq("active", true);
      expect(stats.data.activeMaterials).toBe(mats.count);
      const locs = await admin.from("locations").select("id", { count: "exact", head: true }).eq("active", true);
      expect(stats.data.activeLocations).toBe(locs.count);
      expect(stats.data.materialsInStock).toBeGreaterThanOrEqual(2); // A i C
      expect(stats.data.operationsToday.RECEIPT ?? 0).toBeGreaterThanOrEqual(4);
    }
    const prod = await asProd.rpc("dashboard_stats");
    expect(prod.error?.code).toBe("42501");
    const a = await anon.rpc("dashboard_stats");
    expect(a.error).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("export_stock_csv", () => {
  const CRLF = "\r\n";
  const HEADER_LOCATION =
    "Kod materiału;Nazwa materiału;Kategoria;Jednostka;Lokalizacja;Nazwa lokalizacji;Ilość;Zarezerwowane (materiał);Wolne (materiał)";
  const HEADER_MATERIAL =
    "Kod materiału;Nazwa materiału;Kategoria;Jednostka;Stan łączny;Zarezerwowane;Wolne;Stan minimalny;Brakuje do minimum;Poniżej minimum;Liczba lokalizacji;Domyślny dostawca";
  const exportCsv = (
    session: SupabaseClient,
    variant: string,
    opts: { q?: string | null; category?: string | null; below?: boolean } = {},
  ) =>
    session.rpc("export_stock_csv", {
      p_variant: variant,
      p_q: opts.q === undefined ? `${P}-` : opts.q,
      p_category_id: opts.category === undefined ? ids.category : opts.category,
      p_below_min: opts.below ?? false,
    });
  const text = (lines: string[]) => lines.join(CRLF) + CRLF;

  it("per lokalizacja: tylko stan > 0, filtr kategorii/frazy, posortowane, liczby z przecinkiem, bez BOM", async () => {
    const res = await exportCsv(asBiuro, "location");
    expect(res.error).toBeNull();
    expect(res.data).toBe(
      text([
        HEADER_LOCATION,
        `${P}-A;Materiał A;${P}-kat;szt.;${P}-L1;;9;0;12`,
        `${P}-A;Materiał A;${P}-kat;szt.;${P}-L2;;3;0;12`,
        `${P}-C;Materiał C;${P}-kat;szt.;${P}-L1;;100;0;100`,
      ]),
    );
    expect((res.data as string).charCodeAt(0)).not.toBe(0xfeff);
  });

  it("p_below_min w wariancie location: tylko materiały poniżej minimum", async () => {
    const res = await exportCsv(asBiuro, "location", { below: true });
    expect(res.error).toBeNull();
    expect(res.data).toBe(
      text([
        HEADER_LOCATION,
        `${P}-A;Materiał A;${P}-kat;szt.;${P}-L1;;9;0;12`,
        `${P}-A;Materiał A;${P}-kat;szt.;${P}-L2;;3;0;12`,
      ]),
    );
  });

  it("suma per materiał: minimum, brak, flaga TAK/NIE; filtr poniżej minimum; stan 0 + minimum w widoku", async () => {
    const all = await exportCsv(asBiuro, "material");
    expect(all.data).toBe(
      text([
        HEADER_MATERIAL,
        `${P}-A;Materiał A;${P}-kat;szt.;12;0;12;20;8;TAK;2;`,
        `${P}-B;Materiał B;${P}-kat;mb;0;0;0;2,5;2,5;TAK;0;`,
        `${P}-C;Materiał C;${P}-kat;szt.;100;0;100;;0;NIE;1;`,
      ]),
    );
    const below = await exportCsv(asBiuro, "material", { below: true });
    expect(below.data).toBe(
      text([
        HEADER_MATERIAL,
        `${P}-A;Materiał A;${P}-kat;szt.;12;0;12;20;8;TAK;2;`,
        `${P}-B;Materiał B;${P}-kat;mb;0;0;0;2,5;2,5;TAK;0;`,
      ]),
    );
  });

  it("pusty wynik: sam nagłówek; zły wariant → VALIDATION; PRODUKCJA/anon → odmowa", async () => {
    const none = await exportCsv(asBiuro, "material", { q: `${P}-NIE-MA-TAKIEGO` });
    expect(none.data).toBe(HEADER_MATERIAL + CRLF);
    const bad = await asAdmin.rpc("export_stock_csv", { p_variant: "inny" });
    expect(bad.error?.hint).toBe("VALIDATION");
    const prod = await asProd.rpc("export_stock_csv", { p_variant: "location" });
    expect(prod.error?.code).toBe("42501");
    const a = await anon.rpc("export_stock_csv", { p_variant: "location" });
    expect(a.error).not.toBeNull();
  });

  it("fraza ze znakami LIKE jest dosłowna (% nie jest wildcardem)", async () => {
    const lit = await exportCsv(asBiuro, "material", { q: `${P}-%`, category: null });
    expect(lit.error).toBeNull();
    expect(lit.data).toBe(HEADER_MATERIAL + CRLF);
  });

  it("cytowanie, CSV injection i kody-liczby w pliku (dane z bazy)", async () => {
    const res = await exportCsv(asBiuro, "location", { q: null, category: ids.category4 });
    expect(res.error).toBeNull();
    expect(res.data).toBe(
      text([
        HEADER_LOCATION,
        // kod wyglądający na liczbę (0-wiodące) → ="KOD" (w CSV z podwojonymi cudzysłowami); lokalizacja też
        `"=""${ids.numCode}""";Cyfry;${P}-kat4;mb;"=""${ids.numLocCode}""";;2,5;0;2,5`,
        `${P}-X1;'=cmd|' /C calc'!A0;${P}-kat4;szt.;${P}-L1;;1;0;1`,
        `${P}-X2;"Profil; ""biały""\nlinia2";${P}-kat4;szt.;${P}-L1;;2;0;2`,
        `${P}-X3;'-2+3;${P}-kat4;szt.;${P}-L1;;3;0;3`,
      ]),
    );
  });

  it("limit wierszy: błąd TOO_MANY_ROWS przez serwis (mapowanie na 400) — mapowanie bez wstawiania 20 tys. wierszy", async () => {
    const { exportStockCsv } = await import("@/server/overview");
    const fake = {
      rpc: async () => ({ data: null, error: { code: "P0001", hint: "TOO_MANY_ROWS", message: "x" } }),
    } as unknown as SupabaseClient;
    const r = await exportStockCsv(fake, { variant: "location", belowMin: false });
    expect(!r.ok && r.error.status).toBe(400);
    expect(!r.ok && r.error.code).toBe("TOO_MANY_ROWS");
    const ok = await exportStockCsv(asBiuro, { variant: "material", q: `${P}-`, categoryId: ids.category, belowMin: false }, new Date("2026-10-02T08:07:00Z"));
    expect(ok.ok && ok.data.filename).toBe("stany-materialy_2026-10-02_1007.csv");
  });
});

describe("pomocnicze funkcje CSV (app.csv_*)", () => {
  const one = async (query: string, value: string | number | null) => {
    const rows = await sql.unsafe(query, [value]);
    return rows[0]?.r as string;
  };

  it("csv_text: cytowanie ; \" CR LF, przecinek bez cudzysłowu, null → pusto", async () => {
    expect(await one("select app.csv_text($1::text) as r", "a;b")).toBe('"a;b"');
    expect(await one("select app.csv_text($1::text) as r", 'mówi "cześć"')).toBe('"mówi ""cześć"""');
    expect(await one("select app.csv_text($1::text) as r", "l1\nl2")).toBe('"l1\nl2"');
    expect(await one("select app.csv_text($1::text) as r", "l1\r\nl2")).toBe('"l1\r\nl2"');
    expect(await one("select app.csv_text($1::text) as r", "a,b")).toBe("a,b");
    expect(await one("select app.csv_text($1::text) as r", null)).toBe("");
    expect(await one("select app.csv_text($1::text) as r", "Profil K518")).toBe("Profil K518");
  });

  it("csv_text: CSV injection — = + - @ tab CR dostają apostrof; wiodąca spacja nie (Excel nie liczy formuły)", async () => {
    for (const bad of ["=1+1", "+48123", "-2+3", "@SUM(A1)", "\tcmd"]) {
      expect(await one("select app.csv_text($1::text) as r", bad), JSON.stringify(bad)).toBe("'" + bad);
    }
    expect(await one("select app.csv_text($1::text) as r", "\rcmd")).toBe("\"'\rcmd\"");
    expect(await one("select app.csv_text($1::text) as r", ' =1+1')).toBe(" =1+1");
    expect(await one("select app.csv_text($1::text) as r", "A=B")).toBe("A=B");
    expect(await one("select app.csv_text($1::text) as r", '=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"');
  });

  it("csv_num: przecinek dziesiętny, bez zer końcowych i separatora tysięcy, ujemne bez prefiksu", async () => {
    expect(await one("select app.csv_num($1::numeric) as r", "12.500")).toBe("12,5");
    expect(await one("select app.csv_num($1::numeric) as r", "100.000")).toBe("100");
    expect(await one("select app.csv_num($1::numeric) as r", "1234567.125")).toBe("1234567,125");
    expect(await one("select app.csv_num($1::numeric) as r", "-3")).toBe("-3");
    expect(await one("select app.csv_num($1::numeric) as r", "0")).toBe("0");
    expect(await one("select app.csv_num($1::numeric) as r", null)).toBe("");
  });

  it("csv_code: kody, które Excel zmieniłby (liczba/data/notacja) → =\"KOD\"; pozostałe bez zmian", async () => {
    const lit = (c: string) => `"=""${c}"""`;
    for (const c of ["0518", "518", "12-03", "1/2", "12.05", "12345678901234567890", "1E5", "1E-5", "0 1", "-12"]) {
      expect(await one("select app.csv_code($1::text) as r", c), c).toBe(lit(c));
    }
    for (const c of ["K518", "K518 RAL9016", "A1", "TEST-1", "A-01", "12A", "E5", "1-A"]) {
      expect(await one("select app.csv_code($1::text) as r", c), c).toBe(c);
    }
    // znaki spoza bezpiecznego wzorca → zwykłe cytowanie/neutralizacja, nigdy formuła
    expect(await one("select app.csv_code($1::text) as r", '12"3')).toBe('"12""3"');
    expect(await one("select app.csv_code($1::text) as r", "1;2")).toBe('"1;2"');
    expect(await one("select app.csv_code($1::text) as r", "=1+1")).toBe("'=1+1");
    expect(await one("select app.csv_code($1::text) as r", "1+2")).toBe("1+2");
    expect(await one("select app.csv_code($1::text) as r", null)).toBe("");
  });
});

describe("dashboard_stats: doba Europe/Warsaw, ADJUSTMENT i REVERSAL", () => {
  /** Północ czasu warszawskiego dla bieżącego dnia (instant), liczona w teście niezależnie od SQL. */
  function warsawMidnight(now: Date): number {
    const fmt = (d: Date) =>
      Object.fromEntries(
        new Intl.DateTimeFormat("en-GB", {
          timeZone: "Europe/Warsaw",
          year: "numeric",
          month: "numeric",
          day: "numeric",
          hour: "numeric",
          minute: "numeric",
          second: "numeric",
          hourCycle: "h23",
        })
          .formatToParts(d)
          .filter((p) => p.type !== "literal")
          .map((p) => [p.type, Number(p.value)]),
      ) as Record<string, number>;
    const offset = (d: Date) => {
      const p = fmt(d);
      return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(d.getTime() / 1000) * 1000;
    };
    const p = fmt(now);
    const wallMidnight = Date.UTC(p.year, p.month - 1, p.day);
    let candidate = wallMidnight - offset(now);
    candidate = wallMidnight - offset(new Date(candidate)); // korekta przy zmianie czasu w ciągu doby
    return candidate;
  }

  it("początek doby w SQL = północ Europe/Warsaw liczona w teście", async () => {
    const rows = await sql`select (date_trunc('day', now() at time zone 'Europe/Warsaw') at time zone 'Europe/Warsaw') as start, now() as now`;
    const start = (rows[0].start as Date).getTime();
    expect(start).toBe(warsawMidnight(rows[0].now as Date));
  });

  it("liczniki dzisiejszych operacji = liczba operacji od północy wg typu (także ADJUSTMENT i REVERSAL)", async () => {
    // Materiał R: przyjęcie 5 → korekta do 8 → cofnięcie przyjęcia (5 ≤ 8, więc dozwolone).
    const rcv = await asProd.rpc("stock_receipt", {
      p_client_request_id: randomUUID(),
      p_location_id: ids.l1,
      p_material_id: ids.mR,
      p_quantity: 5,
    });
    expect(rcv.error).toBeNull();
    const adj = await asAdmin.rpc("stock_adjust", {
      p_client_request_id: randomUUID(),
      p_material_id: ids.mR,
      p_location_id: ids.l1,
      p_target_quantity: 8,
      p_expected_current: 5,
      p_reason_code: "ZNALEZIONE",
      p_reason: null,
      p_note: null,
    });
    expect(adj.error).toBeNull();
    const rev = await asAdmin.rpc("stock_reverse", {
      p_client_request_id: randomUUID(),
      p_operation_id: (rcv.data as { operation_id: string }).operation_id,
      p_reason: "test cofnięcia",
    });
    expect(rev.error).toBeNull();

    const stats = await getDashboardStats(asBiuro);
    expect(stats.ok).toBe(true);
    if (!stats.ok) return;
    const start = new Date(warsawMidnight(new Date())).toISOString();
    const counts: Record<string, number> = {};
    for (const type of ["RECEIPT", "ISSUE", "TRANSFER", "ADJUSTMENT", "REVERSAL"]) {
      const c = await admin.from("stock_operations").select("id", { count: "exact", head: true }).eq("type", type).gte("created_at", start);
      counts[type] = c.count ?? 0;
    }
    expect(stats.data.operationsToday.ADJUSTMENT).toBeGreaterThanOrEqual(1);
    expect(stats.data.operationsToday.REVERSAL).toBeGreaterThanOrEqual(1);
    for (const type of Object.keys(counts)) expect(stats.data.operationsToday[type] ?? 0, type).toBe(counts[type]);
  });
});

describe("spójność po testach", () => {
  it("verify_stock = 0 rozbieżności", async () => {
    const { data, error } = await admin.rpc("verify_stock", { p_material_ids: testMaterials });
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});
