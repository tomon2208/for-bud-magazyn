import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { updateMaterial } from "@/server/catalog";
import { updateLocation } from "@/server/locations";
import { createReceipt, listMovements, listStock } from "@/server/stock";
import { adminClient, anonClient, createTestUser, deleteAllTestUsers, signIn, type TestUser } from "./helpers";

// Rdzeń stocku + przyjęcia na bazie dev (ADR 009): RLS, role, poprawność, współbieżność, idempotencja,
// niemutowalność, blokady kartoteki. Dane testowe: prefiks TEST-<runId>-; sprzątanie przez
// public.purge_test_stock (tylko service_role, tylko materiały is_test = true), potem kartoteki i konta.

const admin = adminClient();
const anon = anonClient();
const RUN = randomBytes(4).toString("hex").toUpperCase();
const P = `TEST-${RUN}`;
const dbUrl = process.env.SUPABASE_DB_URL;
let sql: postgres.Sql;

let tAdmin: TestUser;
let tBiuro: TestUser;
let tProd: TestUser;
let tProd2: TestUser;
let tInactive: TestUser;
let asAdmin: SupabaseClient;
let asBiuro: SupabaseClient;
let asProd: SupabaseClient;
let asProd2: SupabaseClient;
let asProdB: SupabaseClient; // druga sesja tego samego konta
let asInactive: SupabaseClient;

const ids = {
  category: "",
  supplier: "",
  supplierOff: "",
  mSzt: "", // szt. — całkowite
  mMb: "", // mb — ułamki
  mSztanga: "",
  mOff: "",
  mLock: "",
  mConc: "",
  mIdem: "",
  mRace: "",
  lA: "",
  lB: "",
  lOff: "",
  lEmpty: "",
  lRace: "",
  lRace2: "",
};
const allMaterialIds = () => [ids.mSzt, ids.mMb, ids.mSztanga, ids.mOff, ids.mLock, ids.mConc, ids.mIdem, ids.mRace];

type RpcArgs = {
  p_client_request_id?: string;
  p_location_id: string;
  p_material_id: string;
  p_quantity: number | string;
  p_supplier_id?: string | null;
  p_document_ref?: string | null;
  p_note?: string | null;
};

function receipt(client: SupabaseClient, args: RpcArgs) {
  return client.rpc("stock_receipt", { p_client_request_id: randomUUID(), ...args });
}

async function stockQty(materialId: string, locationId: string): Promise<number> {
  const { data, error } = await admin
    .from("stock")
    .select("quantity")
    .eq("material_id", materialId)
    .eq("location_id", locationId)
    .maybeSingle();
  if (error) throw error;
  return data ? Number(data.quantity) : 0;
}

async function expectConsistent() {
  const { data, error } = await admin.rpc("verify_stock", { p_material_ids: allMaterialIds() });
  expect(error).toBeNull();
  expect(data).toEqual([]);
}

/** Materiały testowe: is_test = true (może ustawić wyłącznie klucz secret) — tylko takie czyści purge_test_stock. */
const testMaterials: string[] = [];
async function material(code: string, unit: string, extra: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from("materials")
    .insert({ code: `${P}-${code}`, name: `Materiał ${code}`, unit, category_id: ids.category, is_test: true, ...extra })
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

/** SQL jako użytkownik aplikacji (rola authenticated + claims JWT), w transakcji połączenia `tx`. */
async function actAs(tx: postgres.TransactionSql, userId: string) {
  await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`;
  await tx.unsafe("set local role authenticated");
}

const NOT_BLOCKED = "NIE_ZABLOKOWANO";
/** Transakcja kończona ZAWSZE rollbackiem; zwraca błąd (albo komunikat NOT_BLOCKED). */
async function rolledBack(fn: (tx: postgres.TransactionSql) => Promise<unknown>) {
  return sql
    .begin(async (tx) => {
      await fn(tx);
      throw new Error(NOT_BLOCKED);
    })
    .catch((e: { hint?: string; code?: string; message: string }) => e);
}

beforeAll(async () => {
  if (!dbUrl) throw new Error("Brak SUPABASE_DB_URL w .env.scripts");
  sql = postgres(dbUrl, { max: 4, prepare: false, onnotice: () => {} });
  await deleteAllTestUsers(admin);
  tAdmin = await createTestUser(admin, "ADMIN");
  tBiuro = await createTestUser(admin, "BIURO");
  tProd = await createTestUser(admin, "PRODUKCJA");
  tProd2 = await createTestUser(admin, "PRODUKCJA", "produkcja2");
  tInactive = await createTestUser(admin, "PRODUKCJA", "nieaktywny");
  [asAdmin, asBiuro, asProd, asProd2, asProdB, asInactive] = await Promise.all([
    signIn(tAdmin),
    signIn(tBiuro),
    signIn(tProd),
    signIn(tProd2),
    signIn(tProd),
    signIn(tInactive),
  ]);
  const off = await admin.from("profiles").update({ active: false }).eq("id", tInactive.id);
  if (off.error) throw off.error;

  const cat = await asAdmin.from("material_categories").insert({ name: `${P}-kat` }).select("id").single();
  if (cat.error) throw cat.error;
  ids.category = cat.data.id;
  const sup = await asAdmin.from("suppliers").insert({ name: `${P}-dost` }).select("id").single();
  const supOff = await asAdmin.from("suppliers").insert({ name: `${P}-dost-off` }).select("id").single();
  if (sup.error || supOff.error) throw sup.error ?? supOff.error;
  ids.supplier = sup.data.id;
  ids.supplierOff = supOff.data.id;

  ids.mSzt = await material("SZT", "szt.");
  ids.mMb = await material("MB", "mb");
  ids.mSztanga = await material("SZTANGA", "sztanga");
  ids.mOff = await material("OFF", "szt.");
  ids.mLock = await material("LOCK", "mb");
  ids.mConc = await material("CONC", "szt.");
  ids.mIdem = await material("IDEM", "szt.");
  ids.mRace = await material("RACE", "szt.");
  ids.lA = await location("A");
  ids.lB = await location("B");
  ids.lOff = await location("OFF");
  ids.lEmpty = await location("EMPTY");
  ids.lRace = await location("RACE");
  ids.lRace2 = await location("RACE2");

  // Dezaktywacje na końcu (przed jakimkolwiek ruchem).
  const r1 = await asAdmin.from("materials").update({ active: false }).eq("id", ids.mOff);
  const r2 = await asAdmin.from("locations").update({ active: false }).eq("id", ids.lOff);
  const r3 = await asAdmin.from("suppliers").update({ active: false }).eq("id", ids.supplierOff);
  if (r1.error || r2.error || r3.error) throw r1.error ?? r2.error ?? r3.error;
});

afterAll(async () => {
  try {
    const purge = await admin.rpc("purge_test_stock", { p_material_ids: testMaterials });
    if (purge.error) console.warn("purge_test_stock:", purge.error.message);
    await admin.from("materials").delete().like("code", `${P}-%`);
    await admin.from("locations").delete().like("code", `${P}-%`);
    await admin.from("suppliers").delete().like("name", `${P}-%`);
    await admin.from("material_categories").delete().like("name", `${P}-%`);
  } finally {
    await sql?.end();
    await deleteAllTestUsers(admin);
  }
});

// ---------------------------------------------------------------------------
describe("allows_fraction — domyślnie wg jednostki", () => {
  it("szt./sztanga/opak. (warianty) → false, mb/kg → true; jawna wartość wygrywa", async () => {
    const { data } = await admin.from("materials").select("id, allows_fraction").in("id", [ids.mSzt, ids.mMb, ids.mSztanga]);
    const byId = Object.fromEntries((data ?? []).map((r) => [r.id, r.allows_fraction]));
    expect(byId[ids.mSzt]).toBe(false);
    expect(byId[ids.mMb]).toBe(true);
    expect(byId[ids.mSztanga]).toBe(false);
    for (const [unit, expected] of [["SZT", false], ["Opak", false], ["opak.", false], ["kpl", false], ["Komplet", false], ["PARA", false], ["rolka", false], ["kg", true], ["m²", true]] as const) {
      const id = await material(`U${randomBytes(2).toString("hex").toUpperCase()}`, unit);
      const row = await admin.from("materials").select("allows_fraction").eq("id", id).single();
      expect(row.data?.allows_fraction, unit).toBe(expected);
    }
    const explicit = await material("EXPL", "szt.", { allows_fraction: true });
    const row = await admin.from("materials").select("allows_fraction").eq("id", explicit).single();
    expect(row.data?.allows_fraction).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("RLS i uprawnienia tabel stockowych", () => {
  const tables = ["stock", "stock_operations", "stock_movements"] as const;

  const writes = () => ({
    stock: { col: "material_id", insert: { material_id: ids.mSzt, location_id: ids.lEmpty, quantity: 1 }, update: { quantity: 5 } },
    stock_operations: {
      col: "id",
      insert: { type: "RECEIPT", user_id: tAdmin.id, client_request_id: randomUUID() },
      update: { note: "x" },
    },
    stock_movements: { col: "id", insert: { quantity_delta: 1 }, update: { quantity_delta: 5 } },
  });

  it("authenticated (także ADMIN) nie może INSERT/UPDATE/DELETE", async () => {
    for (const session of [asAdmin, asProd, asBiuro]) {
      for (const [table, w] of Object.entries(writes())) {
        const ins = await session.from(table).insert(w.insert as Record<string, unknown>);
        expect(ins.error?.code, `${table} insert`).toBe("42501");
        const upd = await session.from(table).update(w.update).not(w.col, "is", null);
        expect(upd.error?.code, `${table} update`).toBe("42501");
        const del = await session.from(table).delete().not(w.col, "is", null);
        expect(del.error?.code, `${table} delete`).toBe("42501");
      }
    }
  });

  it("service_role (klucz secret) też ma tylko SELECT", async () => {
    for (const [table, w] of Object.entries(writes())) {
      const ins = await admin.from(table).insert(w.insert as Record<string, unknown>);
      expect(ins.error?.code, table).toBe("42501");
      const upd = await admin.from(table).update(w.update).not(w.col, "is", null);
      expect(upd.error?.code, table).toBe("42501");
      const del = await admin.from(table).delete().not(w.col, "is", null);
      expect(del.error?.code, table).toBe("42501");
    }
  });

  it("anon nie czyta, nieaktywny nie widzi nic, BIURO/PRODUKCJA czytają", async () => {
    await receipt(asProd, { p_location_id: ids.lA, p_material_id: ids.mSzt, p_quantity: 1 });
    for (const table of [...tables, "v_stock"]) {
      const a = await anon.from(table).select("*").limit(1);
      expect(a.error?.code, table).toBe("42501");
      const i = await asInactive.from(table).select("*").limit(5);
      expect(i.error, table).toBeNull();
      expect(i.data, table).toHaveLength(0);
    }
    for (const session of [asBiuro, asProd]) {
      const s = await session.from("v_stock").select("quantity, material_code").eq("material_id", ids.mSzt);
      expect(s.error).toBeNull();
      expect(s.data?.[0]?.material_code).toBe(`${P}-SZT`);
      const m = await session.from("stock_movements").select("id").eq("material_id", ids.mSzt);
      expect(m.data?.length).toBeGreaterThan(0);
    }
  });

  it("purge_test_stock niedostępne dla authenticated/anon; tylko materiały is_test", async () => {
    for (const session of [asAdmin, anon]) {
      const res = await session.rpc("purge_test_stock", { p_material_ids: [ids.mSzt] });
      expect(res.error).not.toBeNull();
    }
    const real = await asAdmin
      .from("materials")
      .insert({ code: `${P}-REAL`, name: "Nie-testowy", unit: "szt.", category_id: ids.category })
      .select("id, is_test")
      .single();
    expect(real.data?.is_test).toBe(false);
    const bad = await admin.rpc("purge_test_stock", { p_material_ids: [ids.mSzt, real.data!.id] });
    expect(bad.error?.code).toBe("22023");
  });

  it("is_test: authenticated (ADMIN) nie ustawi ani nie zmieni; service_role nie zmieni po INSERT", async () => {
    const ins = await asAdmin
      .from("materials")
      .insert({ code: `${P}-FAKE`, name: "x", unit: "szt.", category_id: ids.category, is_test: true });
    expect(ins.error?.code).toBe("42501");
    const upd = await asAdmin.from("materials").update({ is_test: false }).eq("id", ids.mSzt);
    expect(upd.error?.code).toBe("42501");
    const upd2 = await asAdmin.from("materials").update({ is_test: true }).eq("code", `${P}-REAL`);
    expect(upd2.error?.code).toBe("42501");
    const svc = await admin.from("materials").update({ is_test: true }).eq("code", `${P}-REAL`);
    expect(svc.error?.code).toBe("42501");
  });
});

// ---------------------------------------------------------------------------
describe("stock_receipt — rola", () => {
  it("BIURO, nieaktywny i anon → odmowa; nic nie zapisano", async () => {
    const before = await stockQty(ids.mSzt, ids.lB);
    for (const session of [asBiuro, asInactive]) {
      const res = await receipt(session, { p_location_id: ids.lB, p_material_id: ids.mSzt, p_quantity: 5 });
      expect(res.error?.code).toBe("42501");
    }
    const a = await receipt(anon, { p_location_id: ids.lB, p_material_id: ids.mSzt, p_quantity: 5 });
    expect(a.error).not.toBeNull();
    expect(await stockQty(ids.mSzt, ids.lB)).toBe(before);
  });

  it("verify_stock: BIURO/PRODUKCJA → 42501, ADMIN dozwolony", async () => {
    for (const session of [asBiuro, asProd]) {
      const res = await session.rpc("verify_stock", { p_material_ids: [ids.mSzt] });
      expect(res.error?.code).toBe("42501");
    }
    const ok = await asAdmin.rpc("verify_stock", { p_material_ids: [ids.mSzt] });
    expect(ok.error).toBeNull();
    expect(ok.data).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("stock_receipt — poprawność", () => {
  it("zwiększa stan, tworzy operację RECEIPT i ruch z autorem, dostawcą, dokumentem", async () => {
    const before = await stockQty(ids.mMb, ids.lA);
    const crid = randomUUID();
    const res = await asProd.rpc("stock_receipt", {
      p_client_request_id: crid,
      p_location_id: ids.lA,
      p_material_id: ids.mMb,
      p_quantity: "12.5",
      p_supplier_id: ids.supplier,
      p_document_ref: "  WZ 123/2026 ",
      p_note: " ",
    });
    expect(res.error).toBeNull();
    expect(res.data).toMatchObject({ quantity: 12.5, new_location_quantity: before + 12.5, idempotent_replay: false });
    expect(await stockQty(ids.mMb, ids.lA)).toBe(before + 12.5);

    const op = await admin.from("stock_operations").select("*").eq("client_request_id", crid).single();
    expect(op.data).toMatchObject({
      type: "RECEIPT",
      user_id: tProd.id,
      supplier_id: ids.supplier,
      document_ref: "WZ 123/2026",
      note: null,
      production_order_id: null,
    });
    const mv = await admin.from("stock_movements").select("*").eq("operation_id", op.data!.id);
    expect(mv.data).toHaveLength(1);
    expect(mv.data![0]).toMatchObject({ material_id: ids.mMb, location_id: ids.lA, user_id: tProd.id });
    expect(Number(mv.data![0].quantity_delta)).toBe(12.5);
    await expectConsistent();
  });

  it("drugie przyjęcie do tej samej lokalizacji sumuje się; inna lokalizacja ma osobny stan", async () => {
    const a0 = await stockQty(ids.mSzt, ids.lA);
    const b0 = await stockQty(ids.mSzt, ids.lB);
    await receipt(asProd, { p_location_id: ids.lA, p_material_id: ids.mSzt, p_quantity: 3 });
    const r = await receipt(asAdmin, { p_location_id: ids.lB, p_material_id: ids.mSzt, p_quantity: 7 });
    expect(r.error).toBeNull();
    expect(await stockQty(ids.mSzt, ids.lA)).toBe(a0 + 3);
    expect(await stockQty(ids.mSzt, ids.lB)).toBe(b0 + 7);
    await expectConsistent();
  });

  it("serwis createReceipt: wynik w camelCase", async () => {
    const res = await createReceipt(asProd, {
      client_request_id: randomUUID(),
      location_id: ids.lB,
      material_id: ids.mMb,
      quantity: 0.125,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toMatchObject({ quantity: 0.125, idempotentReplay: false });
  });
});

// ---------------------------------------------------------------------------
describe("stock_receipt — walidacja", () => {
  const cases: [string, Partial<RpcArgs>, string][] = [
    ["ilość 0", { p_quantity: 0 }, "INVALID_QUANTITY"],
    ["ilość ujemna", { p_quantity: -1 }, "INVALID_QUANTITY"],
    ["ilość za duża", { p_quantity: 1000000.001 }, "INVALID_QUANTITY"],
    ["skala 4", { p_quantity: "1.2345" }, "INVALID_QUANTITY"],
    ["ułamek dla sztangi", { p_material_id: "SZTANGA", p_quantity: "1.5" }, "NOT_INTEGER"],
    ["ułamek dla szt.", { p_material_id: "SZT", p_quantity: 0.5 }, "NOT_INTEGER"],
    ["materiał nieaktywny", { p_material_id: "OFF" }, "MATERIAL_INACTIVE"],
    ["lokalizacja nieaktywna", { p_location_id: "OFF" }, "LOCATION_INACTIVE"],
    ["dostawca nieaktywny", { p_supplier_id: "OFF" }, "SUPPLIER_INACTIVE"],
    ["materiał nie istnieje", { p_material_id: randomUUID() }, "NOT_FOUND"],
    ["lokalizacja nie istnieje", { p_location_id: randomUUID() }, "NOT_FOUND"],
    ["dostawca nie istnieje", { p_supplier_id: randomUUID() }, "NOT_FOUND"],
    ["dokument > 100", { p_document_ref: "x".repeat(101) }, "VALIDATION"],
    ["notatka > 500", { p_note: "x".repeat(501) }, "VALIDATION"],
  ];

  it.each(cases)("%s → %s, bez zmian stanu", async (_name, override, hint) => {
    const resolve = (v: unknown, map: Record<string, string>) => (typeof v === "string" && v in map ? map[v] : v);
    const args = {
      p_location_id: ids.lA,
      p_material_id: ids.mMb,
      p_quantity: 1 as number | string,
      ...override,
    } as RpcArgs;
    args.p_material_id = resolve(args.p_material_id, { SZTANGA: ids.mSztanga, SZT: ids.mSzt, OFF: ids.mOff }) as string;
    args.p_location_id = resolve(args.p_location_id, { OFF: ids.lOff }) as string;
    args.p_supplier_id = resolve(args.p_supplier_id, { OFF: ids.supplierOff }) as string | null | undefined;

    const { count: before } = await admin.from("stock_operations").select("id", { count: "exact", head: true }).eq("user_id", tProd.id);
    const res = await receipt(asProd, args);
    expect(res.error?.code).toBe("P0001");
    expect(res.error?.hint).toBe(hint);
    const { count: after } = await admin.from("stock_operations").select("id", { count: "exact", head: true }).eq("user_id", tProd.id);
    expect(after).toBe(before);
  });

  it("sztanga: liczba całkowita z zerami po przecinku (2.000) jest OK", async () => {
    const res = await receipt(asProd, { p_location_id: ids.lA, p_material_id: ids.mSztanga, p_quantity: "2.000" });
    expect(res.error).toBeNull();
  });

  it("mapowanie błędów w serwisie: NOT_INTEGER → 400, NOT_FOUND → 404 z nazwą obiektu", async () => {
    const a = await createReceipt(asProd, { client_request_id: randomUUID(), location_id: ids.lA, material_id: ids.mSztanga, quantity: 1.5 });
    expect(a.ok ? null : a.error).toMatchObject({ status: 400, code: "NOT_INTEGER" });
    const b = await createReceipt(asProd, { client_request_id: randomUUID(), location_id: randomUUID(), material_id: ids.mMb, quantity: 1 });
    expect(b.ok ? null : b.error).toMatchObject({ status: 404, code: "NOT_FOUND", message: "Nie znaleziono lokalizacji" });
    const c = await createReceipt(asBiuro, { client_request_id: randomUUID(), location_id: ids.lA, material_id: ids.mMb, quantity: 1 });
    expect(c.ok ? null : c.error).toMatchObject({ status: 403 });
  });
});

// ---------------------------------------------------------------------------
describe("współbieżność", () => {
  it("20 równoległych przyjęć tego samego materiału do tej samej lokalizacji (4 sesje, 3 konta) → stan = suma", async () => {
    const sessions = [asProd, asProd2, asAdmin, asProdB];
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        receipt(sessions[i % sessions.length], { p_location_id: ids.lA, p_material_id: ids.mConc, p_quantity: i + 1 }),
      ),
    );
    for (const r of results) expect(r.error).toBeNull();
    const expected = (N * (N + 1)) / 2; // 210
    expect(await stockQty(ids.mConc, ids.lA)).toBe(expected);
    const { count } = await admin.from("stock_movements").select("id", { count: "exact", head: true }).eq("material_id", ids.mConc);
    expect(count).toBe(N);
    // Każde przyjęcie widziało spójny stan po sobie; maksymalny stan po operacji = suma końcowa.
    const after = results.map((r) => Number((r.data as { new_location_quantity: number }).new_location_quantity));
    expect(Math.max(...after)).toBe(expected);
    expect(new Set(after).size).toBe(N);
    await expectConsistent();
  });

  it("przyjęcie w toku blokuje dezaktywację lokalizacji; po zatwierdzeniu → LOCATION_NOT_EMPTY", async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    let receiptDone!: () => void;
    const receiptStarted = new Promise<void>((r) => (receiptDone = r));

    const txA = sql.begin(async (tx) => {
      await actAs(tx, tProd.id);
      await tx`select public.stock_receipt(${randomUUID()}::uuid, ${ids.lRace}::uuid, ${ids.mRace}::uuid, 4::numeric)`;
      receiptDone();
      await gateA; // transakcja otwarta: trzyma FOR UPDATE na materiale i FOR SHARE na lokalizacji
    });
    await receiptStarted;

    let settled = false;
    const txB = sql
      .begin(async (tx) => {
        await actAs(tx, tAdmin.id);
        await tx`update public.locations set active = false where id = ${ids.lRace}`;
      })
      .then(
        () => ({ hint: "COMMITTED" }),
        (e: { hint?: string }) => e,
      )
      .finally(() => (settled = true));

    await new Promise((r) => setTimeout(r, 1500));
    expect(settled).toBe(false); // dezaktywacja czeka na zakończenie przyjęcia
    releaseA();
    await txA;
    const errB = await txB;
    expect(errB.hint).toBe("LOCATION_NOT_EMPTY");
    const loc = await admin.from("locations").select("active").eq("id", ids.lRace).single();
    expect(loc.data?.active).toBe(true);
    expect(await stockQty(ids.mRace, ids.lRace)).toBe(4);
  });

  it("dezaktywacja lokalizacji w toku blokuje przyjęcie; po zatwierdzeniu → LOCATION_INACTIVE", async () => {
    let releaseB!: () => void;
    const gateB = new Promise<void>((r) => (releaseB = r));
    let updated!: () => void;
    const updateDone = new Promise<void>((r) => (updated = r));

    const txB = sql.begin(async (tx) => {
      await actAs(tx, tAdmin.id);
      await tx`update public.locations set active = false where id = ${ids.lRace2}`;
      updated();
      await gateB;
    });
    await updateDone;

    let settled = false;
    const txA = sql
      .begin(async (tx) => {
        await actAs(tx, tProd.id);
        await tx`select public.stock_receipt(${randomUUID()}::uuid, ${ids.lRace2}::uuid, ${ids.mRace}::uuid, 1::numeric)`;
      })
      .then(
        () => ({ hint: "COMMITTED" }),
        (e: { hint?: string }) => e,
      )
      .finally(() => (settled = true));

    await new Promise((r) => setTimeout(r, 1500));
    expect(settled).toBe(false);
    releaseB();
    await txB;
    expect((await txA).hint).toBe("LOCATION_INACTIVE");
    expect(await stockQty(ids.mRace, ids.lRace2)).toBe(0);
    await asAdmin.from("locations").update({ active: true }).eq("id", ids.lRace2);
  });

  it("przyjęcie w toku blokuje dezaktywację materiału; po zatwierdzeniu → HAS_STOCK", async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    let receiptDone!: () => void;
    const receiptStarted = new Promise<void>((r) => (receiptDone = r));

    const txA = sql.begin(async (tx) => {
      await actAs(tx, tProd.id);
      await tx`select public.stock_receipt(${randomUUID()}::uuid, ${ids.lRace2}::uuid, ${ids.mRace}::uuid, 2::numeric)`;
      receiptDone();
      await gateA;
    });
    await receiptStarted;

    let settled = false;
    const txB = sql
      .begin(async (tx) => {
        await actAs(tx, tAdmin.id);
        await tx`update public.materials set active = false where id = ${ids.mRace}`;
      })
      .then(
        () => ({ hint: "COMMITTED" }),
        (e: { hint?: string }) => e,
      )
      .finally(() => (settled = true));

    await new Promise((r) => setTimeout(r, 1500));
    expect(settled).toBe(false);
    releaseA();
    await txA;
    expect((await txB).hint).toBe("HAS_STOCK");
    await expectConsistent();
  });
});

// ---------------------------------------------------------------------------
describe("idempotencja (client_request_id)", () => {
  it("ten sam id wysłany równolegle 5× → 1 operacja, 1 ruch, stan zwiększony raz", async () => {
    const crid = randomUUID();
    const before = await stockQty(ids.mIdem, ids.lA);
    const args = { p_client_request_id: crid, p_location_id: ids.lA, p_material_id: ids.mIdem, p_quantity: 6 };
    const results = await Promise.all([asProd, asProdB, asProd, asProdB, asProd].map((s) => s.rpc("stock_receipt", args)));
    for (const r of results) expect(r.error).toBeNull();
    const replays = results.map((r) => (r.data as { idempotent_replay: boolean }).idempotent_replay);
    expect(replays.filter((x) => !x)).toHaveLength(1);
    expect(replays.filter((x) => x)).toHaveLength(4);
    const opIds = new Set(results.map((r) => (r.data as { operation_id: string }).operation_id));
    expect(opIds.size).toBe(1);

    expect(await stockQty(ids.mIdem, ids.lA)).toBe(before + 6);
    const ops = await admin.from("stock_operations").select("id").eq("client_request_id", crid);
    expect(ops.data).toHaveLength(1);
    const mv = await admin.from("stock_movements").select("id").eq("operation_id", ops.data![0].id);
    expect(mv.data).toHaveLength(1);
    await expectConsistent();
  });

  it("powtórzenie po czasie zwraca ten sam wynik (replay) bez nowego ruchu", async () => {
    const crid = randomUUID();
    const args = { p_client_request_id: crid, p_location_id: ids.lB, p_material_id: ids.mIdem, p_quantity: 2, p_document_ref: "FV/1" };
    const first = await asProd.rpc("stock_receipt", args);
    const second = await asProd.rpc("stock_receipt", { ...args, p_document_ref: " FV/1 " }); // ta sama wartość po normalizacji
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(second.data).toMatchObject({ operation_id: first.data.operation_id, movement_id: first.data.movement_id, idempotent_replay: true });
  });

  it("ten sam id z innymi parametrami → IDEMPOTENCY_CONFLICT", async () => {
    const crid = randomUUID();
    const args = { p_client_request_id: crid, p_location_id: ids.lA, p_material_id: ids.mIdem, p_quantity: 1 };
    expect((await asProd.rpc("stock_receipt", args)).error).toBeNull();
    for (const changed of [
      { p_quantity: 2 },
      { p_location_id: ids.lB },
      { p_material_id: ids.mSzt },
      { p_supplier_id: ids.supplier },
      { p_note: "inna" },
    ]) {
      const res = await asProd.rpc("stock_receipt", { ...args, ...changed });
      expect(res.error?.hint, JSON.stringify(changed)).toBe("IDEMPOTENCY_CONFLICT");
    }
    const res = await createReceipt(asProd, { client_request_id: crid, location_id: ids.lA, material_id: ids.mIdem, quantity: 5 });
    expect(res.ok ? null : res.error).toMatchObject({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
  });

  it("ten sam id od innego użytkownika → IDEMPOTENCY_CONFLICT (nie ujawnia cudzej operacji)", async () => {
    const crid = randomUUID();
    const args = { p_client_request_id: crid, p_location_id: ids.lA, p_material_id: ids.mIdem, p_quantity: 1 };
    expect((await asProd.rpc("stock_receipt", args)).error).toBeNull();
    const other = await asProd2.rpc("stock_receipt", args);
    expect(other.error?.hint).toBe("IDEMPOTENCY_CONFLICT");
    expect(other.data).toBeNull();
    await expectConsistent();
  });
});

// ---------------------------------------------------------------------------
describe("niemutowalność historii i stanu (także ścieżki uprzywilejowane)", () => {
  it("UPDATE/DELETE ruchu i operacji, zapis stanu z pominięciem funkcji, TRUNCATE → IMMUTABLE (SQL jako postgres)", async () => {
    const { data: mv } = await admin.from("stock_movements").select("id, operation_id").eq("material_id", ids.mSzt).limit(1).single();
    const attempts: [string, (tx: postgres.TransactionSql) => Promise<unknown>][] = [
      ["update ruchu", (tx) => tx`update public.stock_movements set quantity_delta = 999 where id = ${mv!.id}`],
      ["delete ruchu", (tx) => tx`delete from public.stock_movements where id = ${mv!.id}`],
      ["update operacji", (tx) => tx`update public.stock_operations set note = 'x' where id = ${mv!.operation_id}`],
      ["delete operacji", (tx) => tx`delete from public.stock_operations where id = ${mv!.operation_id}`],
      ["update stanu", (tx) => tx`update public.stock set quantity = 1000 where material_id = ${ids.mSzt}`],
      ["delete stanu", (tx) => tx`delete from public.stock where material_id = ${ids.mSzt}`],
      [
        "insert stanu",
        (tx) => tx`insert into public.stock (material_id, location_id, quantity) values (${ids.mMb}, ${ids.lEmpty}, 5)`,
      ],
      ["truncate ruchów", (tx) => tx`truncate public.stock_movements`],
      ["truncate stanu", (tx) => tx`truncate public.stock`],
      [
        "update ruchu przy włączonej fladze sprzątania",
        async (tx) => {
          await tx`select set_config('forbud.purge_test', 'on', true)`;
          await tx`update public.stock_movements set quantity_delta = 999 where id = ${mv!.id}`;
        },
      ],
    ];
    for (const [name, fn] of attempts) {
      const err = await rolledBack(fn);
      expect(err.hint, name).toBe("IMMUTABLE");
    }
  });

  it("authenticated nie zmieni historii nawet przez SQL z rolą authenticated (brak uprawnień)", async () => {
    const err = await rolledBack(async (tx) => {
      await actAs(tx, tAdmin.id);
      await tx`delete from public.stock_movements where material_id = ${ids.mSzt}`;
    });
    expect(err.code).toBe("42501");
  });

  it("stock_receipt nie zostawia włączonej flagi zapisu stanu w transakcji", async () => {
    const err = await rolledBack(async (tx) => {
      await actAs(tx, tProd.id);
      await tx`select public.stock_receipt(${randomUUID()}::uuid, ${ids.lB}::uuid, ${ids.mSzt}::uuid, 1::numeric)`;
      await tx.unsafe("reset role");
      await tx`update public.stock set quantity = 12345 where material_id = ${ids.mSzt}`;
    });
    expect(err.hint).toBe("IMMUTABLE");
  });
});

// ---------------------------------------------------------------------------
describe("blokady kartoteki", () => {
  it("materiał bez ruchów: zmiana jednostki i ułamkowości dozwolona", async () => {
    const res = await asAdmin.from("materials").update({ unit: "kg", allows_fraction: false }).eq("id", ids.mLock).select("unit, allows_fraction").single();
    expect(res.error).toBeNull();
    expect(res.data).toEqual({ unit: "kg", allows_fraction: false });
    await asAdmin.from("materials").update({ unit: "mb", allows_fraction: true }).eq("id", ids.mLock);
  });

  it("po pierwszym ruchu: zmiana unit/allows_fraction → UNIT_LOCKED; inne pola i ta sama jednostka OK", async () => {
    expect((await receipt(asProd, { p_location_id: ids.lB, p_material_id: ids.mLock, p_quantity: 1.5 })).error).toBeNull();
    for (const patch of [{ unit: "kg" }, { allows_fraction: false }, { unit: "MB" }]) {
      const res = await asAdmin.from("materials").update(patch).eq("id", ids.mLock);
      expect(res.error?.hint, JSON.stringify(patch)).toBe("UNIT_LOCKED");
    }
    const ok = await asAdmin.from("materials").update({ name: "Nowa nazwa", unit: " mb " }).eq("id", ids.mLock).select("name, unit").single();
    expect(ok.error).toBeNull();
    expect(ok.data).toEqual({ name: "Nowa nazwa", unit: "mb" });

    const svc = await updateMaterial(asAdmin, ids.mLock, { unit: "kg" });
    expect(svc.ok ? null : svc.error).toMatchObject({ status: 409, code: "UNIT_LOCKED" });
  });

  it("dezaktywacja materiału ze stanem → HAS_STOCK (serwis: 409)", async () => {
    const res = await asAdmin.from("materials").update({ active: false }).eq("id", ids.mSzt);
    expect(res.error?.hint).toBe("HAS_STOCK");
    const svc = await updateMaterial(asAdmin, ids.mSzt, { active: false });
    expect(svc.ok ? null : svc.error).toMatchObject({ status: 409, code: "HAS_STOCK" });
  });

  it("dezaktywacja lokalizacji z towarem → LOCATION_NOT_EMPTY; pustej — OK", async () => {
    const res = await asAdmin.from("locations").update({ active: false }).eq("id", ids.lA);
    expect(res.error?.hint).toBe("LOCATION_NOT_EMPTY");
    const svc = await updateLocation(asAdmin, ids.lA, { active: false });
    expect(svc.ok ? null : svc.error).toMatchObject({ status: 409, code: "LOCATION_NOT_EMPTY" });
    const empty = await asAdmin.from("locations").update({ active: false }).eq("id", ids.lEmpty).select("active").single();
    expect(empty.error).toBeNull();
    expect(empty.data?.active).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("odczyt: stany i lista przyjęć", () => {
  it("listStock: tylko > 0, filtr po lokalizacji, nazwy i jednostki", async () => {
    const res = await listStock(asProd, { locationId: ids.lA, page: 1, pageSize: 100 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.items.length).toBeGreaterThan(0);
    for (const row of res.data.items) {
      expect(row.locationId).toBe(ids.lA);
      expect(row.quantity).toBeGreaterThan(0);
    }
    const conc = res.data.items.find((r) => r.materialId === ids.mConc);
    expect(conc).toMatchObject({ quantity: 210, unit: "szt.", materialCode: `${P}-CONC`, locationCode: `${P}-A` });
  });

  it("list_stock_movements: BIURO widzi przyjęcia z nazwiskiem wykonującego; PRODUKCJA — tylko własne", async () => {
    const res = await listMovements(asBiuro, { type: "RECEIPT", q: `${P}-MB`, page: 1, pageSize: 25 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.total).toBeGreaterThanOrEqual(2);
    const withDoc = res.data.items.find((i) => i.documentRef === "WZ 123/2026");
    expect(withDoc).toMatchObject({ type: "RECEIPT", userName: "Test PRODUKCJA", supplierName: `${P}-dost`, unit: "mb" });
    const inactive = await listMovements(asInactive, { type: "RECEIPT", page: 1, pageSize: 25 });
    expect(inactive.ok ? null : inactive.error).toMatchObject({ status: 403 });
  });

  it("list_stock_movements: filtr dat (dziś włącznie / jutro pusto)", async () => {
    const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date());
    const tomorrow = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date(Date.now() + 86_400_000));
    const t = await listMovements(asAdmin, { q: `${P}-CONC`, from: today, to: today, page: 1, pageSize: 100 });
    expect(t.ok && t.data.total).toBe(20);
    const n = await listMovements(asAdmin, { q: `${P}-CONC`, from: tomorrow, page: 1, pageSize: 100 });
    expect(n.ok && n.data.total).toBe(0);
  });

  it("końcowa spójność: verify_stock = 0 rozbieżności", async () => {
    await expectConsistent();
  });
});

// ---------------------------------------------------------------------------
describe("poprawki po review (M2–M4, L4)", () => {
  it("M3: allows_fraction false→true zawsze; true→false tylko gdy ruchy całkowite; unit nadal zablokowany", async () => {
    // mSzt (false) ma tylko ruchy całkowite.
    const on = await asAdmin.from("materials").update({ allows_fraction: true }).eq("id", ids.mSzt);
    expect(on.error).toBeNull();
    const off = await asAdmin.from("materials").update({ allows_fraction: false }).eq("id", ids.mSzt);
    expect(off.error).toBeNull();
    // mMb ma ruchy ułamkowe (12,5 i 0,125).
    const bad = await asAdmin.from("materials").update({ allows_fraction: false }).eq("id", ids.mMb);
    expect(bad.error?.hint).toBe("UNIT_LOCKED");
    const unit = await asAdmin.from("materials").update({ unit: "kg" }).eq("id", ids.mSzt);
    expect(unit.error?.hint).toBe("UNIT_LOCKED");
  });

  it("M2: zmiana kodu prawdziwego materiału na TEST-… nie pozwala wyczyścić jego historii (SQL, rollback)", async () => {
    const err = await rolledBack(async (tx) => {
      const [m] = await tx`
        insert into public.materials (code, name, unit, category_id)
        values (${`REAL-${RUN}`}, 'Prawdziwy', 'szt.', ${ids.category}) returning id, is_test`;
      expect(m.is_test).toBe(false);
      await actAs(tx, tProd.id);
      await tx`select public.stock_receipt(${randomUUID()}::uuid, ${ids.lB}::uuid, ${m.id}::uuid, 2::numeric)`;
      await tx.unsafe("reset role");
      await actAs(tx, tAdmin.id);
      await tx`update public.materials set code = ${`TEST-${RUN}-FAKE`} where id = ${m.id}`;
      await tx.unsafe("reset role");
      await tx.unsafe("set local role service_role");
      const purgeAll = await tx`select public.purge_test_stock(null) as n`.catch((e: Error) => e);
      // purge(null) czyści tylko is_test = true — prawdziwy materiał musi zostać nietknięty.
      if (purgeAll instanceof Error) throw purgeAll;
      const [{ count }] = await tx`select count(*)::int as count from public.stock_movements where material_id = ${m.id}`;
      expect(count).toBe(1);
      const explicit = await tx`select public.purge_test_stock(array[${m.id}::uuid])`.catch((e: { code?: string }) => e);
      expect((explicit as { code?: string }).code).toBe("22023");
    });
    expect(err.message).toBe("NIE_ZABLOKOWANO"); // wszystkie asercje w transakcji przeszły (potem ROLLBACK)
  });

  it("M2: flaga sprzątania ustawiona ręcznie poza service_role nie pozwala usunąć ruchu", async () => {
    const { data: mv } = await admin.from("stock_movements").select("id").eq("material_id", ids.mSzt).limit(1).single();
    const err = await rolledBack(async (tx) => {
      await tx`select set_config('forbud.purge_test', 'on', true)`;
      await tx`delete from public.stock_movements where id = ${mv!.id}`;
    });
    expect(err.hint).toBe("IMMUTABLE");
  });

  it("L4: INSERT do historii z pominięciem funkcji → IMMUTABLE (także postgres)", async () => {
    const { data: mv } = await admin.from("stock_movements").select("operation_id").eq("material_id", ids.mSzt).limit(1).single();
    const e1 = await rolledBack(
      (tx) => tx`insert into public.stock_operations (type, user_id, client_request_id) values ('RECEIPT', ${tAdmin.id}, ${randomUUID()})`,
    );
    expect(e1.hint).toBe("IMMUTABLE");
    const e2 = await rolledBack(
      (tx) => tx`insert into public.stock_movements (operation_id, material_id, location_id, quantity_delta, user_id)
                 values (${mv!.operation_id}, ${ids.mSzt}, ${ids.lA}, 1, ${tAdmin.id})`,
    );
    expect(e2.hint).toBe("IMMUTABLE");
  });

  it("M4: PRODUKCJA widzi tylko własne operacje/ruchy (RLS i list_stock_movements); BIURO wszystkie", async () => {
    const r = await receipt(asProd2, { p_location_id: ids.lB, p_material_id: ids.mIdem, p_quantity: 1 });
    expect(r.error).toBeNull();
    const own = await asProd2.from("stock_movements").select("user_id").in("material_id", allMaterialIds());
    expect(own.data?.length).toBeGreaterThan(0);
    expect(new Set(own.data!.map((x) => x.user_id))).toEqual(new Set([tProd2.id]));
    const ops = await asProd2.from("stock_operations").select("user_id");
    expect(ops.data!.every((x) => x.user_id === tProd2.id)).toBe(true);
    const biuro = await asBiuro.from("stock_movements").select("user_id").in("material_id", allMaterialIds());
    expect(new Set(biuro.data!.map((x) => x.user_id)).size).toBeGreaterThan(1);

    const list = await listMovements(asProd2, { type: "RECEIPT", q: P, page: 1, pageSize: 100 });
    expect(list.ok).toBe(true);
    const { count: mineCount } = await admin
      .from("stock_movements")
      .select("id", { count: "exact", head: true })
      .eq("user_id", tProd2.id)
      .in("material_id", testMaterials);
    const { count: allCount } = await admin
      .from("stock_movements")
      .select("id", { count: "exact", head: true })
      .in("material_id", testMaterials);
    expect(mineCount).toBeGreaterThan(0);
    expect(allCount).toBeGreaterThan(mineCount!);
    if (list.ok) expect(list.data.total).toBe(mineCount);
    const recent = await listMovements(asProd, { type: "RECEIPT", page: 1, pageSize: 10 }, {
      since: new Date(Date.now() - 3_600_000).toISOString(),
    });
    expect(recent.ok && recent.data.items.length).toBeGreaterThan(0);
    await expectConsistent();
  });
});
