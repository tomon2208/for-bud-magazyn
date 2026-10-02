import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrder, listOrders, listOrdersOverview, updateOrder } from "@/server/orders";
import {
  createRequirement,
  exportShortagesCsv,
  getOrderShortages,
  getOrderToIssue,
  getShortageCount,
  listRequirements,
  listShortages,
  withdrawRequirement,
} from "@/server/requirements";
import { adminClient, createTestUser, deleteAllTestUsers, signIn, type TestUser } from "./helpers";

// Etap 8–10 (ADR 013): zlecenia (numer, W produkcji), listy zapotrzebowania (niezmienne), braki (formuła w SQL),
// CSV braków. Dane: materiały is_test (klucz secret) z prefiksem TEST-<runId>-; sprzątanie przez purge_test_stock
// po usunięciu list (service_role).

const admin = adminClient();
const RUN = randomBytes(4).toString("hex").toUpperCase();
const P = `TEST-${RUN}`;
const dbUrl = process.env.SUPABASE_DB_URL;
let sql: postgres.Sql;

let tAdmin: TestUser;
let tBiuro: TestUser;
let tProd: TestUser;
let asAdmin: SupabaseClient;
let asBiuro: SupabaseClient;
let asProd: SupabaseClient;

const ids = { category: "", category2: "", supplier: "", supplier2: "", supplierZ: "" };
const testMaterials: string[] = [];
const testOrders: string[] = [];

async function material(code: string, unit = "szt.", extra: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from("materials")
    .insert({
      code: `${P}-${code}`,
      name: `Materiał ${code}`,
      unit,
      category_id: ids.category,
      default_supplier_id: ids.supplier,
      is_test: true,
      ...extra,
    })
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

async function order(name: string, extra: Record<string, unknown> = {}) {
  const { data, error } = await asBiuro.from("production_orders").insert({ name: `${P}-${name}`, ...extra }).select("id").single();
  if (error) throw error;
  testOrders.push(data.id as string);
  return data.id as string;
}

async function receive(materialId: string, locationId: string, qty: number) {
  const r = await asAdmin.rpc("stock_receipt", {
    p_client_request_id: randomUUID(),
    p_location_id: locationId,
    p_material_id: materialId,
    p_quantity: qty,
  });
  if (r.error) throw r.error;
}

async function issueOn(client: SupabaseClient, materialId: string, locationId: string, qty: number, orderId: string) {
  const r = await client.rpc("stock_issue", {
    p_client_request_id: randomUUID(),
    p_location_id: locationId,
    p_material_id: materialId,
    p_quantity: qty,
    p_production_order_id: orderId,
  });
  if (r.error) throw r.error;
  return (r.data as { operation_id: string }).operation_id;
}

type Item = { material_id: string; quantity: number | string; note?: string | null };
const createReq = (client: SupabaseClient, orderId: string, name: string, items: Item[], crid?: string) =>
  client.rpc("create_requirement", { p_order_id: orderId, p_name: name, p_items: items, p_client_request_id: crid ?? null });

async function requirement(orderId: string, name: string, items: Item[]) {
  const r = await createReq(asBiuro, orderId, name, items);
  if (r.error) throw r.error;
  return (r.data as { requirement_id: string }).requirement_id;
}

type ShortRow = { material_id: string; needed: number; issued: number; remaining: number; available: number; shortage: number };
async function orderShortages(orderId: string): Promise<Map<string, ShortRow>> {
  const r = await asBiuro.rpc("order_shortages", { p_order_id: orderId });
  if (r.error) throw r.error;
  return new Map((r.data as ShortRow[]).map((x) => [x.material_id, { ...x, needed: Number(x.needed), issued: Number(x.issued), remaining: Number(x.remaining), available: Number(x.available), shortage: Number(x.shortage) }]));
}

async function actAs(tx: postgres.TransactionSql, userId: string) {
  await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`;
  await tx.unsafe("set local role authenticated");
}

beforeAll(async () => {
  if (!dbUrl) throw new Error("Brak SUPABASE_DB_URL w .env.scripts");
  sql = postgres(dbUrl, { max: 3, prepare: false, onnotice: () => {} });
  await deleteAllTestUsers(admin);
  tAdmin = await createTestUser(admin, "ADMIN");
  tBiuro = await createTestUser(admin, "BIURO");
  tProd = await createTestUser(admin, "PRODUKCJA");
  [asAdmin, asBiuro, asProd] = await Promise.all([signIn(tAdmin), signIn(tBiuro), signIn(tProd)]);

  const cat = await asAdmin.from("material_categories").insert([{ name: `${P}-kat` }, { name: `${P}-kat2` }]).select("id, name");
  if (cat.error) throw cat.error;
  ids.category = cat.data.find((c) => c.name === `${P}-kat`)!.id;
  ids.category2 = cat.data.find((c) => c.name === `${P}-kat2`)!.id;
  const sup = await admin.from("suppliers").insert([{ name: `${P}-dostawca` }, { name: `${P}-dostawca2` }, { name: `${P}-dostawcaZ` }]).select("id, name");
  if (sup.error) throw sup.error;
  ids.supplier = sup.data.find((s) => s.name === `${P}-dostawca`)!.id;
  ids.supplier2 = sup.data.find((s) => s.name === `${P}-dostawca2`)!.id;
  ids.supplierZ = sup.data.find((s) => s.name === `${P}-dostawcaZ`)!.id;
});

afterAll(async () => {
  try {
    if (testOrders.length > 0) {
      const del = await admin.from("requirements").delete().in("production_order_id", testOrders);
      if (del.error) console.warn("requirements delete:", del.error.message);
    }
    const purge = await admin.rpc("purge_test_stock", { p_material_ids: testMaterials });
    if (purge.error) console.warn("purge_test_stock:", purge.error.message);
    await admin.from("production_orders").delete().like("name", `${P}-%`);
    await admin.from("materials").delete().like("code", `${P}-%`);
    await admin.from("locations").delete().like("code", `${P}-%`);
    await admin.from("material_categories").delete().like("name", `${P}-%`);
    await admin.from("suppliers").delete().like("name", `${P}-%`);
  } finally {
    await sql?.end();
    await deleteAllTestUsers(admin);
  }
});

// ---------------------------------------------------------------------------
describe("zlecenia: numer i status W produkcji", () => {
  it("IN_PRODUCTION przyjęty; numer przycięty, pusty → NULL; wiele zleceń bez numeru", async () => {
    const a = await asBiuro
      .from("production_orders")
      .insert({ name: `${P}-N1`, number: `  Z-${RUN}/1 `, status: "IN_PRODUCTION" })
      .select("id, number, status")
      .single();
    expect(a.error).toBeNull();
    expect(a.data).toMatchObject({ number: `Z-${RUN}/1`, status: "IN_PRODUCTION" });
    testOrders.push(a.data!.id);
    const b = await asBiuro.from("production_orders").insert([{ name: `${P}-N2`, number: "  " }, { name: `${P}-N3` }]).select("id, number");
    expect(b.error).toBeNull();
    expect(b.data!.map((r) => r.number)).toEqual([null, null]);
    testOrders.push(...b.data!.map((r) => r.id));
  });

  it("numer unikalny bez względu na wielkość liter (23505), także przy zmianie; długość ≤ 50 (23514)", async () => {
    const dup = await asBiuro.from("production_orders").insert({ name: `${P}-N4`, number: `z-${RUN}/1` });
    expect(dup.error?.code).toBe("23505");
    const other = await order("N5", { number: `Z-${RUN}/2` });
    const upd = await asBiuro.from("production_orders").update({ number: `Z-${RUN}/1` }).eq("id", other);
    expect(upd.error?.code).toBe("23505");
    const long = await asBiuro.from("production_orders").insert({ name: `${P}-N6`, number: "x".repeat(51) });
    expect(long.error?.code).toBe("23514");
    const bad = await asBiuro.from("production_orders").insert({ name: `${P}-N7`, status: "IN_PROGRESS" });
    expect(bad.error?.code).toBe("23514");
  });

  it("PRODUKCJA nie ustawia statusu ani numeru (RLS); serwis: 409 NUMBER_TAKEN, wyszukiwanie po numerze, filtr ISSUABLE", async () => {
    const id = await order("N8", { number: `Z-${RUN}/8` });
    const upd = await asProd.from("production_orders").update({ status: "IN_PRODUCTION" }).eq("id", id).select("id");
    expect(upd.error === null ? upd.data : upd.error.code).toEqual([]);

    const taken = await createOrder(asBiuro, { name: `${P}-N9`, number: `Z-${RUN}/8`, notes: null });
    expect(taken.ok ? null : taken.error).toMatchObject({ status: 409, code: "NUMBER_TAKEN" });
    const prod = await createOrder(asProd, { name: `${P}-N10`, number: null, notes: null });
    expect(prod.ok ? null : prod.error).toMatchObject({ status: 403 });

    const done = await updateOrder(asBiuro, id, { status: "DONE" });
    expect(done.ok && done.data.status).toBe("DONE");
    const byNumber = await listOrders(asProd, { q: `z-${RUN}/8`, page: 1, pageSize: 50 });
    expect(byNumber.ok && byNumber.data.items.map((o) => o.id)).toEqual([id]);
    expect(byNumber.ok && byNumber.data.items[0].number).toBe(`Z-${RUN}/8`);
    const issuable = await listOrders(asProd, { status: "ISSUABLE", q: `${P}-N`, page: 1, pageSize: 100 });
    expect(issuable.ok && issuable.data.items.every((o) => o.status === "OPEN" || o.status === "IN_PRODUCTION")).toBe(true);
    expect(issuable.ok && issuable.data.items.some((o) => o.id === id)).toBe(false);
    expect(issuable.ok && issuable.data.items.some((o) => o.status === "IN_PRODUCTION")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("listy zapotrzebowania: tworzenie, niezmienność, wycofanie", () => {
  let o: string;
  let m: string;
  let mb: string;
  let mOff: string;
  beforeAll(async () => {
    o = await order("REQ");
    m = await material("REQ-SZT");
    mb = await material("REQ-MB", "mb");
    mOff = await material("REQ-OFF", "szt.", { active: false });
  });

  it("BIURO i ADMIN tworzą; pozycje zapisane, audyt z auth.uid(), ułamki dla mb OK", async () => {
    const r = await createReq(asBiuro, o, `  Okna parter `, [
      { material_id: m, quantity: 3, note: "  pilne " },
      { material_id: mb, quantity: "2.5" },
    ]);
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ item_count: 2, idempotent_replay: false });
    const reqId = (r.data as { requirement_id: string }).requirement_id;
    const row = await admin.from("requirements").select("*").eq("id", reqId).single();
    expect(row.data).toMatchObject({ name: "Okna parter", status: "ACTIVE", source: "MANUAL", created_by: tBiuro.id, withdrawn_at: null });
    const items = await admin.from("requirement_items").select("material_id, quantity, note").eq("requirement_id", reqId);
    expect(items.data!.map((i) => [i.material_id, Number(i.quantity), i.note]).sort()).toEqual(
      [[m, 3, "pilne"], [mb, 2.5, null]].sort(),
    );
    expect((await createReq(asAdmin, o, "Admin", [{ material_id: m, quantity: 1 }])).error).toBeNull();

    const listed = await listRequirements(asProd, o); // PRODUKCJA czyta
    expect(listed.ok && listed.data.map((x) => x.name)).toEqual(["Okna parter", "Admin"]);
    expect(listed.ok && listed.data[0].items.map((i) => [i.materialCode, i.quantity])).toEqual([
      [`${P}-REQ-MB`, 2.5],
      [`${P}-REQ-SZT`, 3],
    ]);
  });

  it("PRODUKCJA nie tworzy (42501); bezpośredni INSERT/UPDATE/DELETE przez rolę aplikacyjną niemożliwy", async () => {
    expect((await createReq(asProd, o, "X", [{ material_id: m, quantity: 1 }])).error?.code).toBe("42501");
    for (const client of [asProd, asBiuro, asAdmin]) {
      expect((await client.from("requirements").insert({ production_order_id: o, name: "X" })).error?.code).toBe("42501");
      expect((await client.from("requirement_items").insert({ requirement_id: randomUUID(), material_id: m, quantity: 1 })).error?.code).toBe("42501");
      expect((await client.from("requirements").update({ name: "Y" }).eq("production_order_id", o)).error?.code).toBe("42501");
      expect((await client.from("requirement_items").update({ quantity: 99 }).eq("material_id", m)).error?.code).toBe("42501");
      expect((await client.from("requirements").delete().eq("production_order_id", o)).error?.code).toBe("42501");
      expect((await client.from("requirement_items").delete().eq("material_id", m)).error?.code).toBe("42501");
    }
  });

  it("niezmienność: UPDATE pozycji i zmiana listy poza wycofaniem odrzucone nawet dla właściciela (IMMUTABLE)", async () => {
    const reqId = await requirement(o, "Niezmienna", [{ material_id: m, quantity: 4 }]);
    await expect(sql`update public.requirement_items set quantity = 99 where requirement_id = ${reqId}`).rejects.toMatchObject({ hint: "IMMUTABLE" });
    await expect(sql`update public.requirements set name = 'inna' where id = ${reqId}`).rejects.toMatchObject({ hint: "IMMUTABLE" });
    await expect(sql`update public.requirements set production_order_id = ${await order("REQ-X")} where id = ${reqId}`).rejects.toMatchObject({ hint: "IMMUTABLE" });
    const after = await admin.from("requirements").select("name, status").eq("id", reqId).single();
    expect(after.data).toEqual({ name: "Niezmienna", status: "ACTIVE" });
  });

  it.each([
    ["ten sam materiał dwa razy", () => [{ material_id: m, quantity: 1 }, { material_id: m, quantity: 2 }], "DUPLICATE_MATERIAL"],
    ["ułamek dla szt.", () => [{ material_id: m, quantity: "1.5" }], "NOT_INTEGER"],
    ["ilość 0", () => [{ material_id: m, quantity: 0 }], "INVALID_QUANTITY"],
    ["ilość ujemna", () => [{ material_id: m, quantity: -2 }], "INVALID_QUANTITY"],
    ["skala 4", () => [{ material_id: mb, quantity: "1.0001" }], "INVALID_QUANTITY"],
    ["ponad limit", () => [{ material_id: mb, quantity: 1000001 }], "INVALID_QUANTITY"],
    ["brak ilości", () => [{ material_id: mb } as unknown as Item], "INVALID_QUANTITY"],
    ["materiał nieaktywny", () => [{ material_id: mOff, quantity: 1 }], "MATERIAL_INACTIVE"],
    ["materiał nie istnieje", () => [{ material_id: randomUUID(), quantity: 1 }], "NOT_FOUND"],
    ["pusta lista", () => [], "VALIDATION"],
    ["pozycja bez materiału", () => [{ quantity: 1 } as unknown as Item], "VALIDATION"],
  ] as [string, () => Item[], string][])("%s → %s, nic nie zapisano", async (_n, items, hint) => {
    const before = await admin.from("requirements").select("id", { count: "exact", head: true }).eq("production_order_id", o);
    const r = await createReq(asBiuro, o, "Błędna", items());
    expect(r.error?.hint).toBe(hint);
    const after = await admin.from("requirements").select("id", { count: "exact", head: true }).eq("production_order_id", o);
    expect(after.count).toBe(before.count);
  });

  it("501 pozycji → VALIDATION; zła nazwa / zły format id → błąd; zlecenie nie istnieje → NOT_FOUND", async () => {
    const many: Item[] = Array.from({ length: 501 }, () => ({ material_id: randomUUID(), quantity: 1 }));
    expect((await createReq(asBiuro, o, "Dużo", many)).error?.hint).toBe("VALIDATION");
    expect((await createReq(asBiuro, o, "   ", [{ material_id: m, quantity: 1 }])).error?.hint).toBe("VALIDATION");
    expect((await createReq(asBiuro, o, "x".repeat(121), [{ material_id: m, quantity: 1 }])).error?.hint).toBe("VALIDATION");
    expect((await createReq(asBiuro, o, "x", [{ material_id: "nie-uuid", quantity: 1 }])).error?.code).toBe("22P02");
    expect((await createReq(asBiuro, randomUUID(), "x", [{ material_id: m, quantity: 1 }])).error?.hint).toBe("NOT_FOUND");
  });

  it("serwis: komunikaty z kodem materiału (NOT_INTEGER / MATERIAL_INACTIVE), 404/403", async () => {
    const frac = await createRequirement(asBiuro, o, { name: "x", items: [{ material_id: m, quantity: 1.5 }] });
    expect(frac.ok ? null : frac.error).toMatchObject({ status: 400, code: "NOT_INTEGER" });
    expect(frac.ok ? "" : frac.error.message).toContain(`${P}-REQ-SZT`);
    const off = await createRequirement(asBiuro, o, { name: "x", items: [{ material_id: mOff, quantity: 1 }] });
    expect(off.ok ? null : off.error).toMatchObject({ status: 400, code: "MATERIAL_INACTIVE" });
    const forbidden = await createRequirement(asProd, o, { name: "x", items: [{ material_id: m, quantity: 1 }] });
    expect(forbidden.ok ? null : forbidden.error).toMatchObject({ status: 403 });
  });

  it("zlecenie zakończone/anulowane → ORDER_NOT_OPEN; W produkcji OK", async () => {
    const done = await order("REQ-DONE");
    expect((await updateOrder(asBiuro, done, { status: "DONE" })).ok).toBe(true);
    expect((await createReq(asBiuro, done, "x", [{ material_id: m, quantity: 1 }])).error?.hint).toBe("ORDER_NOT_OPEN");
    expect((await updateOrder(asBiuro, done, { status: "CANCELLED" })).ok).toBe(true);
    expect((await createReq(asBiuro, done, "x", [{ material_id: m, quantity: 1 }])).error?.hint).toBe("ORDER_NOT_OPEN");
    expect((await updateOrder(asBiuro, done, { status: "IN_PRODUCTION" })).ok).toBe(true);
    expect((await createReq(asBiuro, done, "x", [{ material_id: m, quantity: 1 }])).error).toBeNull();
  });

  it("idempotencja: ten sam client_request_id → jedna lista (także równolegle); inny użytkownik → konflikt", async () => {
    const crid = randomUUID();
    const items = [{ material_id: m, quantity: 2 }];
    const results = await Promise.all([1, 2, 3, 4].map(() => createReq(asBiuro, o, "Idemp", items, crid)));
    expect(results.every((r) => r.error === null)).toBe(true);
    expect(new Set(results.map((r) => (r.data as { requirement_id: string }).requirement_id)).size).toBe(1);
    expect(results.filter((r) => (r.data as { idempotent_replay: boolean }).idempotent_replay === false)).toHaveLength(1);
    const { count } = await admin.from("requirements").select("id", { count: "exact", head: true }).eq("client_request_id", crid);
    expect(count).toBe(1);
    expect((await createReq(asAdmin, o, "Idemp", items, crid)).error?.hint).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("idempotencja (M1): replay z inną nazwą / ilością / zbiorem pozycji / zleceniem → IDEMPOTENCY_CONFLICT; ten sam zbiór w innej kolejności → replay", async () => {
    const crid = randomUUID();
    const base = [{ material_id: m, quantity: 2 }, { material_id: mb, quantity: "1.5" }];
    const first = await createReq(asBiuro, o, "Hash", base, crid);
    expect(first.error).toBeNull();
    const id = (first.data as { requirement_id: string }).requirement_id;
    const conflicts: [string, string, Item[], string][] = [
      ["inna nazwa", "Inna", base, o],
      ["inna ilość", "Hash", [{ material_id: m, quantity: 3 }, base[1]], o],
      ["mniej pozycji", "Hash", [base[0]], o],
      ["inny materiał", "Hash", [base[0], { material_id: await material("REQ-HASH"), quantity: "1.5" }], o],
      ["inna notatka", "Hash", [{ ...base[0], note: "uwaga" }, base[1]], o],
      ["inne zlecenie", "Hash", base, await order("REQ-HASH2")],
    ];
    for (const [name, listName, items, orderId] of conflicts) {
      const r = await createReq(asBiuro, orderId, listName, items, crid);
      expect(r.error?.hint, name).toBe("IDEMPOTENCY_CONFLICT");
    }
    // Ten sam zbiór (inna kolejność, 1.500 = 1.5, spacje w nazwie) → replay istniejącej listy.
    const replay = await createReq(asBiuro, o, "  Hash ", [{ material_id: mb, quantity: "1.500" }, { material_id: m, quantity: 2 }], crid);
    expect(replay.error).toBeNull();
    expect(replay.data).toMatchObject({ requirement_id: id, item_count: 2, idempotent_replay: true });
    const { count } = await admin.from("requirements").select("id", { count: "exact", head: true }).eq("client_request_id", crid);
    expect(count).toBe(1);
  });

  it("zamykanie zlecenia w toku: tworzenie listy czeka, potem ORDER_NOT_OPEN", async () => {
    const race = await order("REQ-RACE");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const firstDone = new Promise<void>((r) => (started = r));
    const txA = sql.begin(async (tx) => {
      await actAs(tx, tBiuro.id);
      await tx`update public.production_orders set status = 'DONE' where id = ${race}`;
      started();
      await gate;
    });
    await firstDone;
    let settled = false;
    const second = Promise.resolve(createReq(asBiuro, race, "Wyścig", [{ material_id: m, quantity: 1 }])).finally(() => (settled = true));
    try {
      await new Promise((r) => setTimeout(r, 1500));
      expect(settled).toBe(false);
    } finally {
      release();
      await txA;
    }
    expect((await second).error?.hint).toBe("ORDER_NOT_OPEN");
  });

  it("wycofanie: tylko BIURO/ADMIN, powód 3–200 znaków, raz; lista pozostaje w bazie ze statusem WITHDRAWN", async () => {
    const reqId = await requirement(o, "Do wycofania", [{ material_id: m, quantity: 1 }]);
    expect((await asProd.rpc("withdraw_requirement", { p_requirement_id: reqId, p_reason: "pomyłka" })).error?.code).toBe("42501");
    for (const reason of ["ab", "  ", "x".repeat(201)]) {
      expect((await asBiuro.rpc("withdraw_requirement", { p_requirement_id: reqId, p_reason: reason })).error?.hint).toBe("VALIDATION");
    }
    expect((await asBiuro.rpc("withdraw_requirement", { p_requirement_id: randomUUID(), p_reason: "pomyłka" })).error?.hint).toBe("NOT_FOUND");
    const ok = await withdrawRequirement(asBiuro, reqId, { reason: "  Zła ilość " });
    expect(ok.ok).toBe(true);
    const row = await admin.from("requirements").select("status, withdraw_reason, withdrawn_at, withdrawn_by").eq("id", reqId).single();
    expect(row.data).toMatchObject({ status: "WITHDRAWN", withdraw_reason: "Zła ilość", withdrawn_by: tBiuro.id });
    expect(row.data!.withdrawn_at).not.toBeNull();
    const again = await withdrawRequirement(asAdmin, reqId, { reason: "jeszcze raz" });
    expect(again.ok ? null : again.error).toMatchObject({ status: 409, code: "ALREADY_WITHDRAWN" });
    // Pozycje wycofanej listy zostają (podgląd + „poprawiona kopia”).
    const items = await admin.from("requirement_items").select("id").eq("requirement_id", reqId);
    expect(items.data).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe("braki zlecenia: formuła na konkretnych liczbach", () => {
  it("potrzebne 12 (suma dwóch list), wydano 10 → pozostało 2; storno zwiększa pozostało; dostępne wspólne", async () => {
    const o = await order("BR1");
    const m = await material("BR1");
    const a = await location("BR1-A");
    await receive(m, a, 10);
    await requirement(o, "Lista 1", [{ material_id: m, quantity: 7 }]);
    await requirement(o, "Lista 2", [{ material_id: m, quantity: 5 }]);

    let row = (await orderShortages(o)).get(m)!;
    expect(row).toMatchObject({ needed: 12, issued: 0, remaining: 12, available: 10, shortage: 2 });

    const opId = await issueOn(asProd, m, a, 10, o);
    row = (await orderShortages(o)).get(m)!;
    expect(row).toMatchObject({ needed: 12, issued: 10, remaining: 2, available: 0, shortage: 2 });

    const rev = await asAdmin.rpc("stock_reverse", { p_client_request_id: randomUUID(), p_operation_id: opId, p_reason: "pomyłka wydania" });
    expect(rev.error).toBeNull();
    row = (await orderShortages(o)).get(m)!;
    expect(row).toMatchObject({ needed: 12, issued: 0, remaining: 12, available: 10, shortage: 2 });

    // Serwis (DTO).
    const dto = await getOrderShortages(asBiuro, o);
    expect(dto.ok && dto.data[0]).toMatchObject({ materialCode: `${P}-BR1`, needed: 12, issued: 0, remaining: 12, available: 10, shortage: 2 });
  });

  it("wydanie ponad potrzebne → pozostało 0 (nie ujemne), brak 0", async () => {
    const o = await order("BR2");
    const m = await material("BR2");
    const a = await location("BR2-A");
    await receive(m, a, 10);
    await requirement(o, "L", [{ material_id: m, quantity: 3 }]);
    await issueOn(asProd, m, a, 5, o);
    expect((await orderShortages(o)).get(m)).toMatchObject({ needed: 3, issued: 5, remaining: 0, available: 5, shortage: 0 });
    // Nie trafia do „do wydania”.
    const toIssue = await getOrderToIssue(asProd, o);
    expect(toIssue.ok && toIssue.data).toEqual([]);
  });

  it("wycofana lista nie liczy się; zlecenie bez list nie ma braków", async () => {
    const o = await order("BR3");
    const m = await material("BR3");
    expect((await orderShortages(o)).size).toBe(0);
    const reqId = await requirement(o, "L", [{ material_id: m, quantity: 4 }]);
    expect((await orderShortages(o)).get(m)).toMatchObject({ needed: 4 });
    expect((await withdrawRequirement(asBiuro, reqId, { reason: "pomyłka" })).ok).toBe(true);
    expect((await orderShortages(o)).size).toBe(0);
  });

  it("nieaktywna lokalizacja nie liczy się do dostępnych", async () => {
    const o = await order("BR4");
    const m = await material("BR4");
    const a = await location("BR4-A");
    const b = await location("BR4-B");
    await receive(m, a, 6);
    await receive(m, b, 4);
    await requirement(o, "L", [{ material_id: m, quantity: 10 }]);
    expect((await orderShortages(o)).get(m)).toMatchObject({ available: 10, shortage: 0 });
    // Dezaktywacja niepustej lokalizacji jest zablokowana triggerem (LOCATION_NOT_EMPTY) — omijamy go WYŁĄCZNIE
    // w jednej transakcji, która zawsze kończy się ROLLBACK (na współdzielonej bazie nic się nie zatwierdza).
    const rollback = new Error("ROLLBACK_TEST");
    const seen: { shortage?: Record<string, unknown>; toIssue?: Record<string, unknown> } = {};
    await sql
      .begin(async (tx) => {
        await tx.unsafe("set local session_replication_role = replica");
        await tx`update public.locations set active = false where id = ${b}`;
        await actAs(tx, tBiuro.id);
        seen.shortage = (await tx`select available, shortage from public.order_shortages(${o}::uuid) where material_id = ${m}`)[0];
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: tProd.id, role: "authenticated" })}, true)`;
        seen.toIssue = (await tx`select remaining, available from public.order_to_issue(${o}::uuid) where material_id = ${m}`)[0];
        throw rollback;
      })
      .catch((e) => {
        if (e !== rollback) throw e;
      });
    expect([Number(seen.shortage?.available), Number(seen.shortage?.shortage)]).toEqual([6, 4]);
    expect([Number(seen.toIssue?.remaining), Number(seen.toIssue?.available)]).toEqual([10, 6]);
    // Nic nie zostało zatwierdzone: lokalizacja nadal aktywna, dostępne znów 10.
    const loc = await admin.from("locations").select("active").eq("id", b).single();
    expect(loc.data?.active).toBe(true);
    expect((await orderShortages(o)).get(m)).toMatchObject({ available: 10, shortage: 0 });
  });

  it("role: order_shortages / shortages_summary / order_overview / export / count — PRODUKCJA 42501; order_to_issue — każda rola", async () => {
    const o = await order("BR5");
    expect((await asProd.rpc("order_shortages", { p_order_id: o })).error?.code).toBe("42501");
    expect((await asProd.rpc("shortages_summary", {})).error?.code).toBe("42501");
    expect((await asProd.rpc("order_overview", { p_order_ids: [o] })).error?.code).toBe("42501");
    expect((await asProd.rpc("export_shortages_csv", {})).error?.code).toBe("42501");
    expect((await asProd.rpc("shortage_material_count")).error?.code).toBe("42501");
    expect((await asProd.rpc("order_to_issue", { p_order_id: o })).error).toBeNull();
    for (const c of [asBiuro, asAdmin]) {
      expect((await c.rpc("order_shortages", { p_order_id: o })).error).toBeNull();
      expect((await c.rpc("shortages_summary", { p_supplier_id: ids.supplier2 })).error).toBeNull();
    }
    // Funkcje pomocnicze nie są dostępne dla ról aplikacyjnych.
    expect((await asBiuro.rpc("requirement_balance", { p_order_ids: [o] })).error).not.toBeNull();
  });

  it("materiał dezaktywowany po utworzeniu listy nadal liczy się do braków (zbiorczo i per zlecenie)", async () => {
    const o = await order("BR7");
    const m = await material("BR7");
    await requirement(o, "L", [{ material_id: m, quantity: 4 }]);
    const off = await admin.from("materials").update({ active: false }).eq("id", m); // bez stanu — dezaktywacja dozwolona
    expect(off.error).toBeNull();
    expect((await orderShortages(o)).get(m)).toMatchObject({ needed: 4, remaining: 4, available: 0, shortage: 4 });
    const all = await listShortages(asBiuro, { supplier: ids.supplier, onlyShort: true });
    expect(all.ok && all.data.items.find((i) => i.materialId === m)).toMatchObject({ remaining: 4, shortage: 4 });
  });

  it("zlecenie zamknięte: „brakuje” = 0 i brak flagi, choć pozostało > 0; zbiorczo pomijane (L2)", async () => {
    const o = await order("BR8");
    const m = await material("BR8");
    await requirement(o, "L", [{ material_id: m, quantity: 4 }]);
    expect((await orderShortages(o)).get(m)).toMatchObject({ remaining: 4, shortage: 4 });
    expect((await updateOrder(asBiuro, o, { status: "DONE" })).ok).toBe(true);
    expect((await orderShortages(o)).get(m)).toMatchObject({ remaining: 4, available: 0, shortage: 0 });
    const ov = await listOrdersOverview(asBiuro, { q: `${P}-BR8`, page: 1, pageSize: 10 });
    expect(ov.ok && ov.data.items[0]).toMatchObject({ requirementCount: 1, hasShortage: false });
    const all = await listShortages(asBiuro, { supplier: ids.supplier, onlyShort: false });
    expect(all.ok && all.data.items.some((i) => i.materialId === m)).toBe(false);
  });

  it("order_overview: null w tablicy id jest pomijany (L4)", async () => {
    const o = await order("BR9");
    await requirement(o, "L", [{ material_id: await material("BR9"), quantity: 1 }]);
    const r = await asBiuro.rpc("order_overview", { p_order_ids: [o, null] });
    expect(r.error).toBeNull();
    expect((r.data as { production_order_id: string }[]).map((x) => x.production_order_id)).toEqual([o]);
  });

  it("lista zleceń z liczbą list i flagą braków", async () => {
    const withShort = await order("BR6");
    const covered = await order("BR6B");
    const none = await order("BR6C");
    const m = await material("BR6");
    const a = await location("BR6-A");
    await receive(m, a, 5);
    await requirement(withShort, "L1", [{ material_id: m, quantity: 9 }]);
    await requirement(withShort, "L2", [{ material_id: m, quantity: 1 }]);
    await requirement(covered, "L", [{ material_id: m, quantity: 2 }]);
    const res = await listOrdersOverview(asBiuro, { q: `${P}-BR6`, page: 1, pageSize: 50 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const by = new Map(res.data.items.map((i) => [i.id, i]));
    expect(by.get(withShort)).toMatchObject({ requirementCount: 2, hasShortage: true });
    expect(by.get(covered)).toMatchObject({ requirementCount: 1, hasShortage: false });
    expect(by.get(none)).toMatchObject({ requirementCount: 0, hasShortage: false });
  });
});

// ---------------------------------------------------------------------------
describe("braki zbiorczo i CSV", () => {
  let o1: string;
  let o2: string;
  let oDone: string;
  let oCancelled: string;
  let mx: string;
  let mCovered: string;
  let mOther: string;
  let mFrac: string;

  beforeAll(async () => {
    o1 = await order("Z1", { number: `Z-${RUN}/A` });
    o2 = await order("Z2", { status: "IN_PRODUCTION" });
    oDone = await order("Z3");
    oCancelled = await order("Z4");
    mx = await material("ZX", "szt.", { default_supplier_id: ids.supplierZ });
    mCovered = await material("ZCOV", "szt.", { default_supplier_id: ids.supplierZ });
    mOther = await material("ZOTH", "szt.", { default_supplier_id: ids.supplier2, category_id: ids.category2 });
    mFrac = await material("ZFRAC", "mb", { name: "=HYPERLINK(\"x\")", default_supplier_id: ids.supplierZ });
    const a = await location("Z-A");
    await receive(mx, a, 10);
    await receive(mCovered, a, 100);
    await receive(mFrac, a, 1.25);
    for (const [ord, qty] of [[o1, 8], [o2, 8], [oDone, 8], [oCancelled, 8]] as const) {
      await requirement(ord, "L", [{ material_id: mx, quantity: qty }]);
    }
    await requirement(o1, "L2", [{ material_id: mCovered, quantity: 5 }, { material_id: mOther, quantity: 3 }, { material_id: mFrac, quantity: "2.5" }]);
    expect((await updateOrder(asBiuro, oDone, { status: "DONE" })).ok).toBe(true);
    expect((await updateOrder(asBiuro, oCancelled, { status: "CANCELLED" })).ok).toBe(true);
  });

  it("dwa zlecenia po 8, stan 10 → brakuje 6 (dostępne liczone raz); DONE/CANCELLED pomijane", async () => {
    const res = await listShortages(asBiuro, { supplier: ids.supplierZ, onlyShort: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const byMat = new Map(res.data.items.map((i) => [i.materialId, i]));
    expect(byMat.get(mx)).toMatchObject({ remaining: 16, available: 10, shortage: 6, supplierName: `${P}-dostawcaZ` });
    expect(byMat.get(mx)!.orders.map((x) => [x.orderId, x.number, x.remaining])).toEqual([[o1, `Z-${RUN}/A`, 8], [o2, null, 8]]);
    expect(byMat.has(mCovered)).toBe(false); // zapas wystarcza → bez filtra „tylko braki” widać, z filtrem nie
    expect(byMat.get(mFrac)).toMatchObject({ remaining: 2.5, available: 1.25, shortage: 1.25 });
    expect(byMat.has(mOther)).toBe(false); // inny dostawca
    expect(res.data.total).toBe(res.data.items.length);

    const all = await listShortages(asBiuro, { supplier: ids.supplierZ, onlyShort: false });
    const allMat = new Map(all.ok ? all.data.items.map((i) => [i.materialId, i]) : []);
    expect(allMat.get(mCovered)).toMatchObject({ remaining: 5, available: 100, shortage: 0 });
  });

  it("filtry: dostawca, kategoria; wydanie na jedno zlecenie zmniejsza pozostało zbiorczo", async () => {
    const other = await listShortages(asAdmin, { supplier: ids.supplier2, onlyShort: true });
    expect(other.ok && other.data.items.map((i) => i.materialId)).toEqual([mOther]);
    const cat = await listShortages(asAdmin, { category: ids.category2, onlyShort: false });
    expect(cat.ok && cat.data.items.map((i) => i.materialId)).toEqual([mOther]);
    expect(other.ok && other.data.items[0]).toMatchObject({ remaining: 3, available: 0, shortage: 3 });

    const a = (await admin.from("locations").select("id").eq("code", `${P}-Z-A`).single()).data!.id as string;
    await issueOn(asProd, mx, a, 4, o1);
    const after = await listShortages(asBiuro, { supplier: ids.supplierZ, onlyShort: true });
    // pozostało 16 − 4 = 12, dostępne 10 − 4 = 6 → brakuje 6 (wydanie nie zmienia braku).
    expect(after.ok && after.data.items.find((i) => i.materialId === mx)).toMatchObject({ remaining: 12, available: 6, shortage: 6 });
    const count = await getShortageCount(asBiuro);
    expect(count.ok && count.data).toBeGreaterThanOrEqual(3);
  });

  it("CSV: nagłówek, sortowanie, przecinek dziesiętny, neutralizacja formuł, lista zleceń", async () => {
    const res = await exportShortagesCsv(asBiuro, { supplier: ids.supplierZ, onlyShort: true }, new Date("2026-10-03T10:05:00Z"));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.filename).toBe("braki_2026-10-03_1205.csv");
    const lines = res.data.body.split("\r\n");
    expect(lines[0]).toBe("Dostawca;Kod materiału;Nazwa materiału;Kategoria;Jednostka;Pozostało do wydania;Dostępne;Brakuje;Zlecenia");
    expect(lines[lines.length - 1]).toBe("");
    // Największy brak pierwszy (ZX: 6), potem ZFRAC (1,25).
    expect(lines[1]).toBe(
      `${P}-dostawcaZ;${P}-ZX;Materiał ZX;${P}-kat;szt.;12;6;6;Z-${RUN}/A ${P}-Z1 (4), ${P}-Z2 (8)`,
    );
    expect(lines[2]).toBe(`${P}-dostawcaZ;${P}-ZFRAC;"'=HYPERLINK(""x"")";${P}-kat;mb;2,5;1,25;1,25;Z-${RUN}/A ${P}-Z1 (2,5)`);
    expect(lines).toHaveLength(4);
    expect(res.data.body).not.toContain("﻿"); // BOM dokleja route handler
  });

  it("CSV: bez wyników tylko nagłówek; brak dostawcy = „brak dostawcy”", async () => {
    const empty = await asBiuro.rpc("export_shortages_csv", { p_supplier_id: randomUUID(), p_only_short: true });
    expect(empty.error).toBeNull();
    expect(empty.data).toBe("Dostawca;Kod materiału;Nazwa materiału;Kategoria;Jednostka;Pozostało do wydania;Dostępne;Brakuje;Zlecenia\r\n");
    const noSup = await material("ZNOSUP", "szt.", { default_supplier_id: null, category_id: ids.category2 });
    const oN = await order("Z5");
    await requirement(oN, "L", [{ material_id: noSup, quantity: 2 }]);
    const csv = await asAdmin.rpc("export_shortages_csv", { p_category_id: ids.category2, p_only_short: true });
    const lines = (csv.data as string).split("\r\n");
    expect(lines.some((l) => l.startsWith(`brak dostawcy;${P}-ZNOSUP;`))).toBe(true);
    // Sortowanie: dostawca z nazwą przed „brak dostawcy”.
    expect(lines[1].startsWith(`${P}-dostawca2;${P}-ZOTH;`)).toBe(true);
  });
});
