import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { updateOrder } from "@/server/orders";
import { getOrderShortages, getOrderToIssue, listShortages } from "@/server/requirements";
import { getMaterialAvailability, getOrderReservations, releaseReservation, reserveForOrder } from "@/server/reservations";
import { createIssue } from "@/server/stock";
import { adminClient, createTestUser, deleteAllTestUsers, signIn, type TestUser } from "./helpers";

// Etap 11 (ADR 014): rezerwacje — reserve/release, rozliczenie przy wydaniu (CONSUME, RESERVED_STOCK, override ADMIN
// LIFO), auto-zwolnienie, nadrezerwacja, braki, idempotencja, niemutowalność i współbieżność.
// Dane: materiały is_test z prefiksem TEST-<runId>-; sprzątanie: listy → purge_test_stock(materiały, zlecenia).

const admin = adminClient();
const RUN = randomBytes(4).toString("hex").toUpperCase();
const P = `TEST-${RUN}`;
const dbUrl = process.env.SUPABASE_DB_URL;
let sql: postgres.Sql;

let tAdmin: TestUser;
let tBiuro: TestUser;
let tProd: TestUser;
let asAdmin: SupabaseClient;
let asAdminB: SupabaseClient;
let asBiuro: SupabaseClient;
let asBiuroB: SupabaseClient;
let asProd: SupabaseClient;
let asProdB: SupabaseClient;

const ids = { category: "" };
const testMaterials: string[] = [];
const testOrders: string[] = [];

async function material(code: string, unit = "szt.") {
  const { data, error } = await admin
    .from("materials")
    .insert({ code: `${P}-${code}`, name: `Materiał ${code}`, unit, category_id: ids.category, is_test: true })
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

async function order(name: string) {
  const { data, error } = await asBiuro.from("production_orders").insert({ name: `${P}-${name}` }).select("id").single();
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

async function requirement(orderId: string, items: { material_id: string; quantity: number | string }[]) {
  const r = await asBiuro.rpc("create_requirement", { p_order_id: orderId, p_name: "L", p_items: items });
  if (r.error) throw r.error;
}

const reserve = (client: SupabaseClient, orderId: string, items: { material_id: string; quantity: number | string }[] | null = null, crid = randomUUID()) =>
  client.rpc("reserve_for_order", { p_client_request_id: crid, p_order_id: orderId, p_items: items });

const release = (client: SupabaseClient, orderId: string, materialId: string | null = null, qty: number | null = null, reason: string | null = null, crid = randomUUID()) =>
  client.rpc("release_reservation", { p_client_request_id: crid, p_order_id: orderId, p_material_id: materialId, p_quantity: qty, p_reason: reason });

type IssueArgs = { order?: string | null; reason?: string | null; override?: boolean; overrideReason?: string | null; crid?: string };
const issue = (client: SupabaseClient, materialId: string, locationId: string, qty: number, a: IssueArgs = {}) =>
  client.rpc("stock_issue", {
    p_client_request_id: a.crid ?? randomUUID(),
    p_location_id: locationId,
    p_material_id: materialId,
    p_quantity: qty,
    p_production_order_id: a.order ?? null,
    p_reason_code: a.order ? null : (a.reason ?? "SERWIS"),
    p_override_reservations: a.override ?? false,
    p_override_reason: a.overrideReason ?? null,
  });

async function reserved(orderId: string, materialId: string): Promise<number> {
  const r = await admin.from("reservations").select("quantity").eq("production_order_id", orderId).eq("material_id", materialId).maybeSingle();
  if (r.error) throw r.error;
  return Number(r.data?.quantity ?? 0);
}

async function reservedTotal(materialId: string): Promise<number> {
  const r = await admin.from("reservations").select("quantity").eq("material_id", materialId);
  if (r.error) throw r.error;
  return (r.data ?? []).reduce((s, x) => s + Number(x.quantity), 0);
}

async function stockTotal(materialId: string): Promise<number> {
  const r = await admin.from("stock").select("quantity").eq("material_id", materialId);
  if (r.error) throw r.error;
  return (r.data ?? []).reduce((s, x) => s + Number(x.quantity), 0);
}

async function events(orderId: string) {
  const r = await asBiuro.rpc("order_reservation_events", { p_order_id: orderId });
  if (r.error) throw r.error;
  return (r.data as { type: string; quantity_delta: string; quantity_after: string; reason: string | null; operation_id: string | null }[])
    .map((e) => ({ ...e, delta: Number(e.quantity_delta), after: Number(e.quantity_after) }));
}

async function verify(materialIds: string[]) {
  const v = await admin.rpc("verify_stock", { p_material_ids: materialIds });
  expect(v.error).toBeNull();
  expect(v.data).toEqual([]);
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
  [asAdmin, asAdminB, asBiuro, asBiuroB, asProd, asProdB] = await Promise.all([
    signIn(tAdmin),
    signIn(tAdmin),
    signIn(tBiuro),
    signIn(tBiuro),
    signIn(tProd),
    signIn(tProd),
  ]);
  const cat = await asAdmin.from("material_categories").insert({ name: `${P}-kat` }).select("id").single();
  if (cat.error) throw cat.error;
  ids.category = cat.data.id;
});

afterAll(async () => {
  try {
    if (testOrders.length > 0) {
      const del = await admin.from("requirements").delete().in("production_order_id", testOrders);
      if (del.error) console.warn("requirements delete:", del.error.message);
    }
    const purge = await admin.rpc("purge_test_stock", { p_material_ids: testMaterials, p_order_ids: testOrders });
    if (purge.error) console.warn("purge_test_stock:", purge.error.message);
    const o = await admin.from("production_orders").delete().like("name", `${P}-%`);
    if (o.error) console.warn("orders delete:", o.error.message);
    await admin.from("materials").delete().like("code", `${P}-%`);
    await admin.from("locations").delete().like("code", `${P}-%`);
    await admin.from("material_categories").delete().like("name", `${P}-%`);
  } finally {
    await sql?.end();
    await deleteAllTestUsers(admin);
  }
});

// ---------------------------------------------------------------------------
describe("rezerwowanie: auto, ręcznie, limity, role", () => {
  it("auto = min(pozostało do zarezerwowania, wolne); drugie zlecenie dostaje resztę wolnego i informację o braku", async () => {
    const m = await material("R1");
    const a = await location("R1-A");
    await receive(m, a, 10);
    const o1 = await order("R1-O1");
    const o2 = await order("R1-O2");
    await requirement(o1, [{ material_id: m, quantity: 6 }]);
    await requirement(o2, [{ material_id: m, quantity: 8 }]);

    const r1 = await reserveForOrder(asBiuro, o1, { client_request_id: randomUUID() });
    expect(r1.ok && r1.data).toMatchObject({ reserved: [{ materialId: m, quantity: 6, reservedTotal: 6 }], notReserved: [] });
    const r2 = await reserveForOrder(asAdmin, o2, { client_request_id: randomUUID() });
    expect(r2.ok && r2.data).toMatchObject({ reserved: [{ quantity: 4 }], notReserved: [{ materialId: m, missing: 4 }] });
    // Ponowne „Zarezerwuj” bez wolnego: nic, informacja o braku.
    const again = await reserve(asBiuro, o2);
    expect(again.error).toBeNull();
    expect(again.data).toMatchObject({ reserved: [], not_reserved: [{ missing: 4 }] });

    const avail = await getMaterialAvailability(asProd, m, o1);
    expect(avail.ok && avail.data).toMatchObject({ stockActive: 10, reservedTotal: 10, free: 0, ownReserved: 6, availableForIssue: 6, overReserved: false });
    expect(avail.ok && avail.data.orders.map((x) => [x.orderId, x.quantity])).toEqual([[o1, 6], [o2, 4]]);

    const view = await getOrderReservations(asBiuro, o2);
    expect(view.ok && view.data.items[0]).toMatchObject({ needed: 8, issued: 0, remaining: 8, reserved: 4, toReserve: 4, free: 0, overReserved: false });
    expect(view.ok && view.data.events.map((e) => [e.type, e.quantityDelta, e.quantityAfter])).toEqual([["RESERVE", 4, 4]]);
    await verify([m]);
  });

  it("ręcznie: ≤ wolne i ≤ pozostało do zarezerwowania; tylko materiały z zapotrzebowania; ułamki; całość albo nic", async () => {
    const m = await material("R2");
    const mb = await material("R2-MB", "mb");
    const other = await material("R2-X");
    const a = await location("R2-A");
    await receive(m, a, 5);
    await receive(mb, a, 3.5);
    const o = await order("R2");
    await requirement(o, [{ material_id: m, quantity: 4 }, { material_id: mb, quantity: "2.5" }]);

    expect((await reserve(asBiuro, o, [{ material_id: m, quantity: 5 }])).error?.hint).toBe("RESERVE_EXCEEDS_REMAINING");
    expect((await reserve(asBiuro, o, [{ material_id: other, quantity: 1 }])).error?.hint).toBe("NOT_IN_REQUIREMENTS");
    expect((await reserve(asBiuro, o, [{ material_id: m, quantity: "1.5" }])).error?.hint).toBe("NOT_INTEGER");
    expect((await reserve(asBiuro, o, [{ material_id: m, quantity: 0 }])).error?.hint).toBe("INVALID_QUANTITY");
    expect((await reserve(asBiuro, o, [{ material_id: m, quantity: 1 }, { material_id: m, quantity: 1 }])).error?.hint).toBe("DUPLICATE_MATERIAL");
    // Druga pozycja niepoprawna → nic nie zarezerwowano (jedna transakcja).
    expect((await reserve(asBiuro, o, [{ material_id: m, quantity: 2 }, { material_id: mb, quantity: 3 }])).error?.hint).toBe("RESERVE_EXCEEDS_REMAINING");
    expect(await reserved(o, m)).toBe(0);

    const ok = await reserve(asBiuro, o, [{ material_id: m, quantity: 3 }, { material_id: mb, quantity: "1.25" }]);
    expect(ok.error).toBeNull();
    expect([await reserved(o, m), await reserved(o, mb)]).toEqual([3, 1.25]);
    expect((await reserve(asBiuro, o, [{ material_id: m, quantity: 2 }])).error?.hint).toBe("RESERVE_EXCEEDS_REMAINING"); // zostało 1

    // Wolne mniejsze niż pozostało: inne zlecenie zabiera wolne.
    const o2 = await order("R2-B");
    await requirement(o2, [{ material_id: m, quantity: 10 }]);
    const r = await reserve(asBiuro, o2, [{ material_id: m, quantity: 3 }]);
    expect(r.error?.hint).toBe("RESERVE_EXCEEDS_FREE");
    const mapped = await reserveForOrder(asBiuro, o2, { client_request_id: randomUUID(), items: [{ material_id: m, quantity: 3 }] });
    expect(mapped.ok ? null : mapped.error).toMatchObject({ status: 409, code: "RESERVE_EXCEEDS_FREE", details: { free: 2 } });
    await verify([m, mb]);
  });

  it("tylko zlecenia OPEN / IN_PRODUCTION; rola PRODUKCJA 42501; zapis bezpośredni niemożliwy", async () => {
    const m = await material("R3");
    const a = await location("R3-A");
    await receive(m, a, 5);
    const o = await order("R3");
    await requirement(o, [{ material_id: m, quantity: 2 }]);
    expect((await reserve(asProd, o)).error?.code).toBe("42501");
    expect((await release(asProd, o)).error?.code).toBe("42501");
    expect((await reserve(asBiuro, randomUUID())).error?.hint).toBe("NOT_FOUND");

    expect((await updateOrder(asBiuro, o, { status: "IN_PRODUCTION" })).ok).toBe(true);
    expect((await reserve(asBiuro, o)).error).toBeNull();
    expect((await updateOrder(asBiuro, o, { status: "DONE" })).ok).toBe(true);
    expect((await reserve(asBiuro, o)).error?.hint).toBe("ORDER_NOT_OPEN");
    expect((await updateOrder(asBiuro, o, { status: "CANCELLED" })).ok).toBe(true);
    expect((await reserve(asBiuro, o)).error?.hint).toBe("ORDER_NOT_OPEN");

    for (const c of [asProd, asBiuro, asAdmin]) {
      expect((await c.from("reservations").insert({ production_order_id: o, material_id: m, quantity: 1 })).error?.code).toBe("42501");
      expect((await c.from("reservations").update({ quantity: 99 }).eq("material_id", m)).error?.code).toBe("42501");
      expect((await c.from("reservation_events").delete().eq("type", "RESERVE")).error?.code).toBe("42501");
    }
    // Klucz secret (service_role) też nie zapisze.
    expect((await admin.from("reservations").update({ quantity: 99 }).eq("material_id", m)).error?.code).toBe("42501");
  });

  it("idempotencja reserve/release: replay zwraca wynik, inne parametry/użytkownik → konflikt; równolegle ten sam id → jedna rezerwacja", async () => {
    const m = await material("R4");
    const a = await location("R4-A");
    await receive(m, a, 20);
    const o = await order("R4");
    await requirement(o, [{ material_id: m, quantity: 10 }]);
    const crid = randomUUID();
    const items = [{ material_id: m, quantity: 3 }];
    const results = await Promise.all([asBiuro, asBiuroB, asBiuro, asBiuroB].map((c) => reserve(c, o, items, crid)));
    expect(results.every((r) => r.error === null)).toBe(true);
    expect(results.filter((r) => (r.data as { idempotent_replay: boolean }).idempotent_replay === false)).toHaveLength(1);
    expect(await reserved(o, m)).toBe(3);
    expect((await reserve(asBiuro, o, [{ material_id: m, quantity: 4 }], crid)).error?.hint).toBe("IDEMPOTENCY_CONFLICT");
    expect((await reserve(asBiuro, o, null, crid)).error?.hint).toBe("IDEMPOTENCY_CONFLICT");
    expect((await reserve(asAdmin, o, items, crid)).error?.hint).toBe("IDEMPOTENCY_CONFLICT");
    // Ten sam id dla zwolnienia → konflikt (inny rodzaj żądania).
    expect((await release(asBiuro, o, m, 1, null, crid)).error?.hint).toBe("IDEMPOTENCY_CONFLICT");

    const rcrid = randomUUID();
    const rel = await Promise.all([asBiuro, asBiuroB].map((c) => release(c, o, m, 1, "test", rcrid)));
    expect(rel.every((r) => r.error === null)).toBe(true);
    expect(await reserved(o, m)).toBe(2);
    expect((await release(asBiuro, o, m, 2, "test", rcrid)).error?.hint).toBe("IDEMPOTENCY_CONFLICT");
    const ev = await events(o);
    expect(ev.map((e) => [e.type, e.delta])).toEqual([["RELEASE", -1], ["RESERVE", 3]]);
  });
});

// ---------------------------------------------------------------------------
describe("wydanie z rezerwacjami", () => {
  it("wydanie na zlecenie zużywa najpierw własną rezerwację (CONSUME), potem wolne; ponad wolne + własna → RESERVED_STOCK", async () => {
    const m = await material("I1");
    const a = await location("I1-A");
    await receive(m, a, 10);
    const o1 = await order("I1-O1");
    const o2 = await order("I1-O2");
    await requirement(o1, [{ material_id: m, quantity: 4 }]);
    await requirement(o2, [{ material_id: m, quantity: 3 }]);
    expect((await reserve(asBiuro, o1)).error).toBeNull(); // 4
    expect((await reserve(asBiuro, o2)).error).toBeNull(); // 3 → wolne 3

    const first = await createIssue(asProd, { client_request_id: randomUUID(), location_id: a, material_id: m, quantity: 2, production_order_id: o1 });
    expect(first.ok && first.data).toMatchObject({ reservationConsumed: 2, reservationsOverridden: [] });
    expect(await reserved(o1, m)).toBe(2);
    // 2 z rezerwacji + 3 wolne = 5 → OK; 6 → RESERVED_STOCK.
    const tooMuch = await createIssue(asProd, { client_request_id: randomUUID(), location_id: a, material_id: m, quantity: 6, production_order_id: o1 });
    expect(tooMuch.ok ? null : tooMuch.error).toMatchObject({
      status: 409,
      code: "RESERVED_STOCK",
      details: { available: 5, free: 3, ownReserved: 2, reservedOthers: 3, orders: [{ orderId: o2, quantity: 3 }] },
    });
    const ok = await issue(asProd, m, a, 5, { order: o1 });
    expect(ok.error).toBeNull();
    expect(ok.data).toMatchObject({ reservation_consumed: 2 });
    expect([await reserved(o1, m), await reserved(o2, m), await stockTotal(m)]).toEqual([0, 3, 3]);

    // Bez zlecenia: wolne 0 → RESERVED_STOCK (nigdy z cudzej rezerwacji).
    const noOrder = await issue(asProd, m, a, 1);
    expect(noOrder.error?.hint).toBe("RESERVED_STOCK");
    // Zlecenie bez rezerwacji tego materiału — tylko wolne.
    const o3 = await order("I1-O3");
    expect((await issue(asProd, m, a, 1, { order: o3 })).error?.hint).toBe("RESERVED_STOCK");
    // Lokalizacja ma za mało → INSUFFICIENT_STOCK przed rezerwacjami.
    expect((await issue(asProd, m, a, 4, { order: o2 })).error?.hint).toBe("INSUFFICIENT_STOCK");

    const ev = await events(o1);
    expect(ev.filter((e) => e.type === "CONSUME").map((e) => e.delta).sort()).toEqual([-2, -2]);
    expect(ev.every((e) => e.type !== "CONSUME" || e.operation_id !== null)).toBe(true);
    await verify([m]);
  });

  it("override ADMIN: zmniejsza rezerwacje innych zleceń od najnowszej (LIFO), zdarzenia OVERRIDE z powodem, flaga w operacji", async () => {
    const m = await material("I2");
    const a = await location("I2-A");
    await receive(m, a, 10);
    const oOld = await order("I2-OLD");
    const oNew = await order("I2-NEW");
    await requirement(oOld, [{ material_id: m, quantity: 6 }]);
    await requirement(oNew, [{ material_id: m, quantity: 4 }]);
    expect((await reserve(asBiuro, oOld)).error).toBeNull();
    expect((await reserve(asBiuro, oNew)).error).toBeNull(); // później → LIFO pierwsza

    // Role: PRODUKCJA i BIURO nie mogą override.
    expect((await issue(asProd, m, a, 1, { override: true, overrideReason: "pilne" })).error?.code).toBe("42501");
    expect((await issue(asBiuro, m, a, 1, { override: true, overrideReason: "pilne" })).error?.code).toBe("42501");
    // Override bez powodu → REASON_REQUIRED; powód bez override → VALIDATION.
    expect((await issue(asAdmin, m, a, 1, { override: true })).error?.hint).toBe("REASON_REQUIRED");
    expect((await issue(asAdmin, m, a, 1, { overrideReason: "pilne" })).error?.hint).toBe("VALIDATION");

    const crid = randomUUID();
    const r = await issue(asAdmin, m, a, 5, { override: true, overrideReason: "  Serwis u klienta ", crid });
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ reservation_consumed: 0, reservations_overridden: [{ order_id: oNew, quantity: 4 }, { order_id: oOld, quantity: 1 }] });
    expect([await reserved(oNew, m), await reserved(oOld, m)]).toEqual([0, 5]);
    const op = await admin.from("stock_operations").select("override_reservations, override_reason").eq("client_request_id", crid).single();
    expect(op.data).toEqual({ override_reservations: true, override_reason: "Serwis u klienta" });
    const evNew = await events(oNew);
    expect(evNew[0]).toMatchObject({ type: "OVERRIDE", delta: -4, after: 0, reason: "Serwis u klienta" });
    // Replay tym samym id — wynik z tymi samymi zdarzeniami (kolejność w replay nieistotna — zdarzenia jednej transakcji
    // mają ten sam created_at); inny powód → konflikt.
    const replay = await issue(asAdmin, m, a, 5, { override: true, overrideReason: "Serwis u klienta", crid });
    expect(replay.data).toMatchObject({ idempotent_replay: true });
    const replayed = (replay.data as { reservations_overridden: { order_id: string; quantity: number }[] }).reservations_overridden;
    expect(new Map(replayed.map((x) => [x.order_id, x.quantity]))).toEqual(new Map([[oNew, 4], [oOld, 1]]));
    expect((await issue(asAdmin, m, a, 5, { override: true, overrideReason: "inny", crid })).error?.hint).toBe("IDEMPOTENCY_CONFLICT");
    expect((await issue(asAdmin, m, a, 5, { crid })).error?.hint).toBe("IDEMPOTENCY_CONFLICT");

    // Route-level: zod wymaga powodu; mapowanie RESERVED_STOCK bez override dla ADMIN-a.
    const blocked = await createIssue(asAdmin, { client_request_id: randomUUID(), location_id: a, material_id: m, quantity: 1, reason_code: "SERWIS" });
    expect(blocked.ok ? null : blocked.error).toMatchObject({ code: "RESERVED_STOCK" });
    await verify([m]);
  });

  it("storno wydania na zlecenie nie odtwarza rezerwacji — towar wraca do wolnego", async () => {
    const m = await material("I3");
    const a = await location("I3-A");
    await receive(m, a, 5);
    const o = await order("I3");
    await requirement(o, [{ material_id: m, quantity: 5 }]);
    expect((await reserve(asBiuro, o)).error).toBeNull();
    const r = await issue(asProd, m, a, 3, { order: o });
    expect(r.error).toBeNull();
    expect(await reserved(o, m)).toBe(2);
    const rev = await asAdmin.rpc("stock_reverse", { p_client_request_id: randomUUID(), p_operation_id: (r.data as { operation_id: string }).operation_id, p_reason: "pomyłka" });
    expect(rev.error).toBeNull();
    expect(await reserved(o, m)).toBe(2);
    const av = await getMaterialAvailability(asBiuro, m);
    expect(av.ok && av.data).toMatchObject({ stockActive: 5, reservedTotal: 2, free: 3 });
    await verify([m]);
  });
});

// ---------------------------------------------------------------------------
describe("zwalnianie", () => {
  it("ręcznie część / materiał / całość z powodem; NOTHING_TO_RELEASE, RELEASE_EXCEEDS", async () => {
    const m1 = await material("Z1");
    const m2 = await material("Z1-B");
    const a = await location("Z1-A");
    await receive(m1, a, 10);
    await receive(m2, a, 10);
    const o = await order("Z1");
    await requirement(o, [{ material_id: m1, quantity: 5 }, { material_id: m2, quantity: 4 }]);
    expect((await reserve(asBiuro, o)).error).toBeNull();

    expect((await release(asBiuro, o, m1, 6)).error?.hint).toBe("RELEASE_EXCEEDS");
    expect((await release(asBiuro, o, null, 1)).error?.hint).toBe("VALIDATION");
    const part = await releaseReservation(asBiuro, o, { client_request_id: randomUUID(), material_id: m1, quantity: 2, reason: "zmiana projektu" });
    expect(part.ok && part.data.released).toEqual([{ materialId: m1, materialCode: `${P}-Z1`, quantity: 2, reservedAfter: 3 }]);
    expect((await release(asAdmin, o, m2)).error).toBeNull();
    expect([await reserved(o, m1), await reserved(o, m2)]).toEqual([3, 0]);
    expect((await release(asBiuro, o, m2)).error?.hint).toBe("NOTHING_TO_RELEASE");
    const all = await release(asBiuro, o);
    expect(all.error).toBeNull();
    expect(await reserved(o, m1)).toBe(0);
    expect((await release(asBiuro, o)).error?.hint).toBe("NOTHING_TO_RELEASE");
    const ev = await events(o);
    expect(ev.find((e) => e.type === "RELEASE" && e.delta === -2)?.reason).toBe("zmiana projektu");
  });

  it("auto-zwolnienie przy DONE i CANCELLED (zdarzenia AUTO_RELEASE), ponowne otwarcie nie przywraca", async () => {
    const m = await material("Z2");
    const a = await location("Z2-A");
    await receive(m, a, 10);
    for (const status of ["DONE", "CANCELLED"] as const) {
      const o = await order(`Z2-${status}`);
      await requirement(o, [{ material_id: m, quantity: 3 }]);
      expect((await reserve(asBiuro, o)).error).toBeNull();
      expect(await reserved(o, m)).toBe(3);
      expect((await updateOrder(asBiuro, o, { status })).ok).toBe(true);
      expect(await reserved(o, m)).toBe(0);
      const ev = await events(o);
      expect(ev[0]).toMatchObject({ type: "AUTO_RELEASE", delta: -3, after: 0 });
      expect(ev[0].reason).toBe(status === "DONE" ? "Zlecenie zakończone" : "Zlecenie anulowane");
      expect((await updateOrder(asBiuro, o, { status: "OPEN" })).ok).toBe(true);
      expect(await reserved(o, m)).toBe(0);
      // Zmiana statusu bez zamknięcia nie tworzy zdarzeń.
      expect((await updateOrder(asBiuro, o, { status: "IN_PRODUCTION" })).ok).toBe(true);
      expect((await events(o)).length).toBe(2);
    }
  });

  it("zamykanie zlecenia w toku: rezerwacja czeka na zmianę statusu, potem ORDER_NOT_OPEN", async () => {
    const m = await material("Z3");
    const a = await location("Z3-A");
    await receive(m, a, 5);
    const o = await order("Z3");
    await requirement(o, [{ material_id: m, quantity: 2 }]);
    let release_!: () => void;
    const gate = new Promise<void>((r) => (release_ = r));
    let started!: () => void;
    const firstDone = new Promise<void>((r) => (started = r));
    const txA = sql.begin(async (tx) => {
      await actAs(tx, tBiuro.id);
      await tx`update public.production_orders set status = 'DONE' where id = ${o}`;
      started();
      await gate;
    });
    await firstDone;
    let settled = false;
    const second = Promise.resolve(reserve(asBiuro, o)).finally(() => (settled = true));
    try {
      await new Promise((r) => setTimeout(r, 1500));
      expect(settled).toBe(false);
    } finally {
      release_();
      await txA;
    }
    expect((await second).error?.hint).toBe("ORDER_NOT_OPEN");
    expect(await reserved(o, m)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("nadrezerwacja, braki, widoki, kartoteka", () => {
  it("korekta w dół → rezerwacje > stan: flagi (widok, dashboard, dostępność), bez automatycznych zmian rezerwacji", async () => {
    const m = await material("N1");
    const a = await location("N1-A");
    await receive(m, a, 5);
    const o = await order("N1");
    await requirement(o, [{ material_id: m, quantity: 5 }]);
    expect((await reserve(asBiuro, o)).error).toBeNull();
    const adj = await asAdmin.rpc("stock_adjust", {
      p_client_request_id: randomUUID(),
      p_material_id: m,
      p_location_id: a,
      p_target_quantity: 2,
      p_expected_current: 5,
      p_reason_code: "ZAGINIECIE",
    });
    expect(adj.error).toBeNull();
    expect(await reserved(o, m)).toBe(5);
    const v = await asBiuro.from("v_material_stock").select("total_quantity, reserved_quantity, free_quantity, over_reserved").eq("material_id", m).single();
    expect(v.data).toEqual({ total_quantity: 2, reserved_quantity: 5, free_quantity: 0, over_reserved: true });
    const dash = await asBiuro.rpc("dashboard_stats");
    expect((dash.data as { over_reserved: number }).over_reserved).toBeGreaterThanOrEqual(1);
    const list = await asBiuro.rpc("over_reserved_materials");
    expect((list.data as { material_id: string }[]).some((x) => x.material_id === m)).toBe(true);
    const view = await getOrderReservations(asBiuro, o);
    expect(view.ok && view.data.items[0]).toMatchObject({ reserved: 5, stockActive: 2, overReserved: true });
    // Wydanie na zlecenie: wolne 0 + własna 5, ale lokalizacja ma 2.
    expect((await issue(asProd, m, a, 2, { order: o })).error).toBeNull();
    expect(await reserved(o, m)).toBe(3);
    // Dezaktywacja materiału z aktywną rezerwacją (stan 0) → HAS_RESERVATIONS.
    const off = await asAdmin.from("materials").update({ active: false }).eq("id", m);
    expect(off.error?.hint).toBe("HAS_RESERVATIONS");
    expect((await release(asBiuro, o)).error).toBeNull();
    expect((await asAdmin.from("materials").update({ active: false }).eq("id", m)).error).toBeNull();
    await verify([m]);
  });

  it("braki per zlecenie uwzględniają rezerwację; zbiorczo bez zmian; „do wydania” = wolne + własna", async () => {
    const m = await material("B1");
    const a = await location("B1-A");
    await receive(m, a, 10);
    const o1 = await order("B1-O1");
    const o2 = await order("B1-O2");
    await requirement(o1, [{ material_id: m, quantity: 8 }]);
    await requirement(o2, [{ material_id: m, quantity: 8 }]);
    // Bez rezerwacji: każde zlecenie widzi 10.
    const before = await getOrderShortages(asBiuro, o2);
    expect(before.ok && before.data[0]).toMatchObject({ available: 10, shortage: 0, reserved: 0, free: 10 });
    expect((await reserve(asBiuro, o1)).error).toBeNull(); // 8 → wolne 2
    const s1 = await getOrderShortages(asBiuro, o1);
    expect(s1.ok && s1.data[0]).toMatchObject({ remaining: 8, reserved: 8, free: 2, available: 10, shortage: 0 });
    const s2 = await getOrderShortages(asBiuro, o2);
    expect(s2.ok && s2.data[0]).toMatchObject({ remaining: 8, reserved: 0, free: 2, available: 2, shortage: 6 });
    const t2 = await getOrderToIssue(asProd, o2);
    expect(t2.ok && t2.data[0]).toMatchObject({ remaining: 8, available: 2, reserved: 0 });
    const t1 = await getOrderToIssue(asProd, o1);
    expect(t1.ok && t1.data[0]).toMatchObject({ remaining: 8, available: 10, reserved: 8 });
    // Zbiorczo: Σ pozostało 16, dostępne liczone raz (stan) = 10, brak 6 — bez zmian względem Etapu 10.
    const all = await listShortages(asBiuro, { onlyShort: false });
    expect(all.ok && all.data.items.find((i) => i.materialId === m)).toMatchObject({ remaining: 16, available: 10, shortage: 6 });
    const ov = await asBiuro.rpc("order_overview", { p_order_ids: [o1, o2] });
    const flags = new Map((ov.data as { production_order_id: string; has_shortage: boolean }[]).map((x) => [x.production_order_id, x.has_shortage]));
    expect([flags.get(o1), flags.get(o2)]).toEqual([false, true]);
  });

  it("niemutowalność zdarzeń i żądań (także dla właściciela bazy); purge tylko dla danych testowych", async () => {
    const m = await material("H1");
    const a = await location("H1-A");
    await receive(m, a, 3);
    const o = await order("H1");
    await requirement(o, [{ material_id: m, quantity: 1 }]);
    expect((await reserve(asBiuro, o)).error).toBeNull();
    await expect(sql`update public.reservation_events set reason = 'x' where reservation_id in (select id from public.reservations where material_id = ${m})`).rejects.toMatchObject({ hint: "IMMUTABLE" });
    await expect(sql`delete from public.reservation_events where reservation_id in (select id from public.reservations where material_id = ${m})`).rejects.toMatchObject({ hint: "IMMUTABLE" });
    await expect(sql`update public.reservations set quantity = 0 where material_id = ${m}`).rejects.toMatchObject({ hint: "IMMUTABLE" });
    await expect(sql`update public.reservation_requests set request_hash = 'x' where production_order_id = ${o}`).rejects.toMatchObject({ hint: "IMMUTABLE" });
    // Role aplikacyjne nie wywołają purge.
    expect((await asAdmin.rpc("purge_test_stock", { p_material_ids: [m] })).error?.code).toBe("42501");
  });
});

// ---------------------------------------------------------------------------
describe("współbieżność", () => {
  it("dwa zlecenia rezerwują równolegle ten sam wolny towar → Σ rezerwacji ≤ wolne (= stan)", async () => {
    for (let round = 0; round < 3; round++) {
      const m = await material(`C1-${round}`);
      const a = await location(`C1-${round}`);
      await receive(m, a, 10);
      const o1 = await order(`C1-${round}-A`);
      const o2 = await order(`C1-${round}-B`);
      await requirement(o1, [{ material_id: m, quantity: 8 }]);
      await requirement(o2, [{ material_id: m, quantity: 8 }]);
      const results = await Promise.all([
        reserve(asBiuro, o1),
        reserve(asBiuroB, o2),
        reserve(asAdmin, o1),
        reserve(asAdminB, o2),
        reserve(asBiuro, o2, [{ material_id: m, quantity: 5 }]),
        reserve(asAdminB, o1, [{ material_id: m, quantity: 5 }]),
      ]);
      for (const r of results) {
        if (r.error) expect(["RESERVE_EXCEEDS_FREE", "RESERVE_EXCEEDS_REMAINING"]).toContain(r.error.hint);
      }
      const total = await reservedTotal(m);
      expect(total).toBe(10);
      expect(await reserved(o1, m)).toBeLessThanOrEqual(8);
      expect(await reserved(o2, m)).toBeLessThanOrEqual(8);
      await verify([m]);
    }
  });

  it("rezerwacja równolegle z wydaniami bez zlecenia → wydania nigdy z zarezerwowanego, Σ rezerwacji ≤ stan", async () => {
    for (let round = 0; round < 3; round++) {
      const m = await material(`C2-${round}`);
      const a = await location(`C2-${round}`);
      await receive(m, a, 10);
      const o = await order(`C2-${round}`);
      await requirement(o, [{ material_id: m, quantity: 10 }]);
      const ops = await Promise.all([
        issue(asProd, m, a, 3),
        reserve(asBiuro, o),
        issue(asProdB, m, a, 3),
        issue(asAdmin, m, a, 3),
        reserve(asBiuroB, o),
        issue(asProd, m, a, 3),
      ]);
      const issuedOk = [ops[0], ops[2], ops[3], ops[5]].filter((r) => r.error === null).length;
      for (const r of [ops[0], ops[2], ops[3], ops[5]]) {
        if (r.error) expect(["RESERVED_STOCK", "INSUFFICIENT_STOCK"]).toContain(r.error.hint);
      }
      const stock = await stockTotal(m);
      const res = await reservedTotal(m);
      expect(stock).toBe(10 - 3 * issuedOk);
      expect(res).toBeLessThanOrEqual(stock); // nigdy nadrezerwacji w wyniku tych operacji
      expect(res + 3 * issuedOk).toBeLessThanOrEqual(10);
      // Żadne wydanie bez zlecenia nie zmniejszyło rezerwacji (brak zdarzeń CONSUME/OVERRIDE).
      const ev = await events(o);
      expect(ev.every((e) => e.type === "RESERVE")).toBe(true);
      await verify([m]);
    }
  });

  it("równoległe wydania na zlecenie z rezerwacją i bez zlecenia: stan ≥ 0, rezerwacja zużywana dokładnie raz", async () => {
    const m = await material("C3");
    const a = await location("C3-A");
    await receive(m, a, 10);
    const o = await order("C3");
    await requirement(o, [{ material_id: m, quantity: 6 }]);
    expect((await reserve(asBiuro, o)).error).toBeNull(); // 6, wolne 4
    const ops = await Promise.all([
      issue(asProd, m, a, 2, { order: o }),
      issue(asProdB, m, a, 2),
      issue(asAdmin, m, a, 2, { order: o }),
      issue(asProd, m, a, 2),
      issue(asProdB, m, a, 2, { order: o }),
      issue(asAdmin, m, a, 2),
    ]);
    const okOrder = [ops[0], ops[2], ops[4]].filter((r) => r.error === null).length;
    const okFree = [ops[1], ops[3], ops[5]].filter((r) => r.error === null).length;
    expect(okOrder).toBe(3); // własna rezerwacja chroni wydania na zlecenie
    expect(okFree).toBe(2); // wolne 4 → dwa razy po 2
    expect(await reserved(o, m)).toBe(0);
    expect(await stockTotal(m)).toBe(0);
    const consumed = (await events(o)).filter((e) => e.type === "CONSUME").reduce((s, e) => s + e.delta, 0);
    expect(consumed).toBe(-6);
    await verify([m]);
  });
});

// ---------------------------------------------------------------------------
// Poprawki po review (M1a, M1b, M2, L1, L2)
// ---------------------------------------------------------------------------
describe("review: poniżej minimum od wolnego (M1a)", () => {
  it("minimum 20, stan 25, rezerwacja 10 → poniżej minimum, brakuje 5 (widoki, dashboard, CSV)", async () => {
    const m = await material("M1A");
    const upd = await asAdmin.from("materials").update({ min_quantity: 20 }).eq("id", m);
    expect(upd.error).toBeNull();
    const a = await location("M1A-A");
    await receive(m, a, 25);
    const o = await order("M1A");
    await requirement(o, [{ material_id: m, quantity: 10 }]);
    const before = await asBiuro.from("v_material_stock").select("below_minimum, shortage").eq("material_id", m).single();
    expect(before.data).toEqual({ below_minimum: false, shortage: 0 });
    expect((await reserve(asBiuro, o)).error).toBeNull();
    const v = await asBiuro
      .from("v_material_stock")
      .select("total_quantity, reserved_quantity, free_quantity, below_minimum, shortage, in_view")
      .eq("material_id", m)
      .single();
    expect(v.data).toEqual({ total_quantity: 25, reserved_quantity: 10, free_quantity: 15, below_minimum: true, shortage: 5, in_view: true });
    const vs = await asBiuro.from("v_stock").select("below_minimum, material_reserved, material_free").eq("material_id", m).single();
    expect(vs.data).toEqual({ below_minimum: true, material_reserved: 10, material_free: 15 });
    const dash = await asBiuro.rpc("dashboard_stats");
    const below = await asBiuro.from("v_material_stock").select("material_id", { count: "exact", head: true }).eq("below_minimum", true);
    expect((dash.data as { below_minimum: number }).below_minimum).toBe(below.count);
    const csv = await asBiuro.rpc("export_stock_csv", { p_variant: "material", p_q: `${P}-M1A`, p_category_id: null, p_below_min: true });
    expect((csv.data as string).split("\r\n")[1]).toBe(`${P}-M1A;Materiał M1A;${P}-kat;szt.;25;10;15;20;5;TAK;1;`);
    const csvLoc = await asBiuro.rpc("export_stock_csv", { p_variant: "location", p_q: `${P}-M1A`, p_category_id: null, p_below_min: true });
    expect((csvLoc.data as string).split("\r\n")[1]).toBe(`${P}-M1A;Materiał M1A;${P}-kat;szt.;${P}-M1A-A;;25;10;15`);
    // Zwolnienie rezerwacji zdejmuje flagę.
    expect((await release(asBiuro, o)).error).toBeNull();
    const after = await asBiuro.from("v_material_stock").select("below_minimum").eq("material_id", m).single();
    expect(after.data?.below_minimum).toBe(false);
  });
});

describe("review: rezerwacje ponad zapotrzebowanie (M1b), RLS (L1), purge (L2)", () => {
  it("wycofanie listy nie zmienia rezerwacji; nadmiar widoczny (zlecenie, dashboard); „Zwolnij nadmiar” z powodem", async () => {
    const m = await material("EX");
    const a = await location("EX-A");
    await receive(m, a, 20);
    const o = await order("EX");
    await requirement(o, [{ material_id: m, quantity: 4 }]);
    const r2 = await asBiuro.rpc("create_requirement", { p_order_id: o, p_name: "L2", p_items: [{ material_id: m, quantity: 6 }] });
    expect(r2.error).toBeNull();
    expect((await reserve(asBiuro, o)).error).toBeNull(); // 10
    const w = await asBiuro.rpc("withdraw_requirement", { p_requirement_id: (r2.data as { requirement_id: string }).requirement_id, p_reason: "pomyłka" });
    expect(w.error).toBeNull();
    expect(await reserved(o, m)).toBe(10); // nic automatycznie
    const over = await asBiuro.rpc("reservations_over_requirement", { p_order_id: o });
    expect(over.data).toEqual([expect.objectContaining({ production_order_id: o, material_id: m, reserved: 10, remaining: 4, excess: 6 })]);
    const dash = await asBiuro.rpc("dashboard_stats");
    expect((dash.data as { over_requirement_orders: number }).over_requirement_orders).toBeGreaterThanOrEqual(1);
    const view = await getOrderReservations(asBiuro, o);
    expect(view.ok && view.data.items[0]).toMatchObject({ reserved: 10, remaining: 4, excess: 6 });

    expect((await asProd.rpc("release_reservation_excess", { p_client_request_id: randomUUID(), p_order_id: o })).error?.code).toBe("42501");
    const crid = randomUUID();
    const rel = await asBiuro.rpc("release_reservation_excess", { p_client_request_id: crid, p_order_id: o });
    expect(rel.error).toBeNull();
    expect(rel.data).toMatchObject({ released: [{ material_id: m, quantity: 6, reserved_after: 4 }], idempotent_replay: false });
    expect((await asBiuro.rpc("release_reservation_excess", { p_client_request_id: crid, p_order_id: o })).data).toMatchObject({ idempotent_replay: true });
    expect(await reserved(o, m)).toBe(4);
    const ev = await events(o);
    expect(ev[0]).toMatchObject({ type: "RELEASE", delta: -6, reason: "Nadmiar po wycofaniu listy" });
    expect((await asBiuro.rpc("release_reservation_excess", { p_client_request_id: randomUUID(), p_order_id: o })).error?.hint).toBe("NOTHING_TO_RELEASE");
    expect(((await asBiuro.rpc("reservations_over_requirement", { p_order_id: o })).data as unknown[]).length).toBe(0);
  });

  it("L1: historia rezerwacji — PRODUKCJA nie widzi zdarzeń (RLS), BIURO widzi; dostępność nadal dla PRODUKCJI", async () => {
    const m = await material("RLS");
    const a = await location("RLS-A");
    await receive(m, a, 3);
    const o = await order("RLS");
    await requirement(o, [{ material_id: m, quantity: 2 }]);
    expect((await reserve(asBiuro, o)).error).toBeNull();
    const resId = (await admin.from("reservations").select("id").eq("material_id", m).single()).data!.id as string;
    const prod = await asProd.from("reservation_events").select("id").eq("reservation_id", resId);
    expect(prod.error).toBeNull();
    expect(prod.data).toEqual([]);
    const biuro = await asBiuro.from("reservation_events").select("id").eq("reservation_id", resId);
    expect(biuro.data).toHaveLength(1);
    expect((await asProd.rpc("order_reservation_events", { p_order_id: o })).error?.code).toBe("42501");
    const av = await getMaterialAvailability(asProd, m, o);
    expect(av.ok && av.data).toMatchObject({ ownReserved: 2, availableForIssue: 3 });
  });

  it("L2: purge_test_stock nie rusza żądań zlecenia o nazwie spoza TEST-…", async () => {
    const m = await material("PRG");
    const a = await location("PRG-A");
    await receive(m, a, 5);
    const ins = await asBiuro.from("production_orders").insert({ name: `REAL-${RUN}` }).select("id").single();
    expect(ins.error).toBeNull();
    const real = ins.data!.id as string;
    testOrders.push(real);
    await requirement(real, [{ material_id: m, quantity: 2 }]);
    const crid = randomUUID();
    expect((await reserve(asBiuro, real, null, crid)).error).toBeNull();
    const purge = await admin.rpc("purge_test_stock", { p_material_ids: [m], p_order_ids: [real] });
    expect(purge.error).toBeNull();
    const req = await admin.from("reservation_requests").select("id").eq("id", crid);
    expect(req.data).toHaveLength(1); // zlecenie spoza TEST- — żądanie zostaje
    // Po nadaniu nazwy testowej (sprzątanie) — usuwane.
    expect((await asBiuro.from("production_orders").update({ name: `${P}-REAL` }).eq("id", real)).error).toBeNull();
    expect((await admin.rpc("purge_test_stock", { p_material_ids: [m], p_order_ids: [real] })).error).toBeNull();
    expect((await admin.from("reservation_requests").select("id").eq("id", crid)).data).toHaveLength(0);
  });
});

describe("review: wymuszone przeploty (M2)", () => {
  /** Transakcja A wykonuje `first` i czeka na bramkę; B (klient API) musi czekać; zwraca wynik B. */
  async function interleave(
    userId: string,
    first: (tx: postgres.TransactionSql) => Promise<unknown>,
    second: () => PromiseLike<{ error: { code?: string; hint?: string } | null }>,
  ) {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let started!: () => void;
    const ready = new Promise<void>((r) => (started = r));
    const txA = sql.begin(async (tx) => {
      await actAs(tx, userId);
      await first(tx);
      started();
      await gate;
    });
    await ready;
    let settled = false;
    const b = Promise.resolve(second()).finally(() => (settled = true));
    try {
      await new Promise((r) => setTimeout(r, 1500));
      expect(settled).toBe(false); // B czeka na blokadę A
    } finally {
      open();
      await txA;
    }
    return b;
  }

  async function sumEventsMatches(materialId: string) {
    const res = await admin.from("reservations").select("id, quantity").eq("material_id", materialId);
    for (const r of res.data ?? []) {
      const ev = await admin.from("reservation_events").select("quantity_delta").eq("reservation_id", r.id);
      const sum = (ev.data ?? []).reduce((s, e) => s + Number(e.quantity_delta), 0);
      expect(Math.round(sum * 1000) / 1000).toBe(Number(r.quantity));
    }
  }

  it("zamknięcie zlecenia w trakcie wydania ADMIN-a z override (zabiera jego rezerwację) → czeka, potem AUTO_RELEASE reszty", async () => {
    const m = await material("X1");
    const a = await location("X1-A");
    await receive(m, a, 10);
    const x = await order("X1-X");
    await requirement(x, [{ material_id: m, quantity: 10 }]);
    expect((await reserve(asBiuro, x)).error).toBeNull(); // 10, wolne 0
    const r = await interleave(
      tAdmin.id,
      (tx) => tx`select public.stock_issue(${randomUUID()}::uuid, ${a}::uuid, ${m}::uuid, 3::numeric, null, 'SERWIS', null, null, true, 'pilne')`,
      () => asBiuro.from("production_orders").update({ status: "DONE" }).eq("id", x),
    );
    expect(r.error).toBeNull();
    expect(await reserved(x, m)).toBe(0);
    const ev = await events(x);
    expect(ev.map((e) => [e.type, e.delta])).toEqual([["AUTO_RELEASE", -7], ["OVERRIDE", -3], ["RESERVE", 10]]);
    await sumEventsMatches(m);
    await verify([m]);
  });

  it("zamknięcie zlecenia w trakcie release_reservation tego zlecenia → czeka, potem AUTO_RELEASE reszty", async () => {
    const m = await material("X2");
    const a = await location("X2-A");
    await receive(m, a, 10);
    const x = await order("X2");
    await requirement(x, [{ material_id: m, quantity: 6 }]);
    expect((await reserve(asBiuro, x)).error).toBeNull();
    const r = await interleave(
      tBiuro.id,
      (tx) => tx`select public.release_reservation(${randomUUID()}::uuid, ${x}::uuid, ${m}::uuid, 2::numeric, 'test')`,
      () => asBiuroB.from("production_orders").update({ status: "CANCELLED" }).eq("id", x),
    );
    expect(r.error).toBeNull();
    const ev = await events(x);
    expect(ev.map((e) => [e.type, e.delta])).toEqual([["AUTO_RELEASE", -4], ["RELEASE", -2], ["RESERVE", 6]]);
    await sumEventsMatches(m);
  });

  it("wydanie na zlecenie (CONSUME) równolegle z jego zamknięciem — obie kolejności", async () => {
    const m = await material("X3");
    const a = await location("X3-A");
    await receive(m, a, 10);
    // (1) wydanie pierwsze: zamknięcie czeka; po nim AUTO_RELEASE pozostałej rezerwacji.
    const x = await order("X3-A");
    await requirement(x, [{ material_id: m, quantity: 5 }]);
    expect((await reserve(asBiuro, x)).error).toBeNull();
    const r = await interleave(
      tProd.id,
      (tx) => tx`select public.stock_issue(${randomUUID()}::uuid, ${a}::uuid, ${m}::uuid, 2::numeric, ${x}::uuid)`,
      () => asBiuro.from("production_orders").update({ status: "DONE" }).eq("id", x),
    );
    expect(r.error).toBeNull();
    expect((await events(x)).map((e) => [e.type, e.delta])).toEqual([["AUTO_RELEASE", -3], ["CONSUME", -2], ["RESERVE", 5]]);
    // (2) zamknięcie pierwsze: wydanie czeka i dostaje ORDER_NOT_OPEN; rezerwacja zwolniona.
    const y = await order("X3-B");
    await requirement(y, [{ material_id: m, quantity: 3 }]);
    expect((await reserve(asBiuro, y)).error).toBeNull();
    const r2 = await interleave(
      tBiuro.id,
      (tx) => tx`update public.production_orders set status = 'DONE' where id = ${y}`,
      () => issue(asProd, m, a, 1, { order: y }),
    );
    expect(r2.error?.hint).toBe("ORDER_NOT_OPEN");
    expect(await reserved(y, m)).toBe(0);
    await sumEventsMatches(m);
    await verify([m]);
  });

  it("losowa mieszanka operacji (wiele rund, kilka materiałów i zleceń): bez 40P01, spójność zdarzeń i stanów", async () => {
    // Deterministyczny generator (powtarzalne uruchomienia).
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = <T,>(arr: T[]) => arr[Math.floor(rnd() * arr.length)];

    const mats = [await material("MIX-1"), await material("MIX-2"), await material("MIX-3")];
    const locs = [await location("MIX-A"), await location("MIX-B")];
    for (const m of mats) for (const l of locs) await receive(m, l, 15);
    const orders: string[] = [];
    for (let i = 0; i < 4; i++) {
      const o = await order(`MIX-O${i}`);
      orders.push(o);
      await requirement(o, mats.map((m) => ({ material_id: m, quantity: 8 })));
    }
    const sessionsAdmin = [asAdmin, asAdminB];
    const sessionsBiuro = [asBiuro, asBiuroB];
    const sessionsProd = [asProd, asProdB];
    const codes: string[] = [];
    let opCount = 0;

    for (let round = 0; round < 6; round++) {
      const ops: PromiseLike<{ error: { code?: string; hint?: string } | null }>[] = [];
      for (let k = 0; k < 12; k++) {
        const m = pick(mats);
        const l = pick(locs);
        const o = pick(orders);
        const kind = Math.floor(rnd() * 8);
        if (kind === 0) ops.push(reserve(pick(sessionsBiuro), o));
        else if (kind === 1) ops.push(issue(pick(sessionsProd), m, l, 1 + Math.floor(rnd() * 3), { order: o }));
        else if (kind === 2) ops.push(issue(pick(sessionsProd), m, l, 1 + Math.floor(rnd() * 2)));
        else if (kind === 3) ops.push(issue(pick(sessionsAdmin), m, l, 1 + Math.floor(rnd() * 3), { override: true, overrideReason: "mieszanka" }));
        else if (kind === 4) ops.push(release(pick(sessionsBiuro), o, m, 1));
        else if (kind === 5) {
          const status = pick(["DONE", "CANCELLED", "OPEN", "IN_PRODUCTION"]);
          ops.push(pick(sessionsBiuro).from("production_orders").update({ status }).eq("id", o));
        } else if (kind === 6) {
          const cur = await admin.from("stock").select("quantity").eq("material_id", m).eq("location_id", l).maybeSingle();
          const current = Number(cur.data?.quantity ?? 0);
          const target = Math.max(0, current + (rnd() < 0.5 ? -2 : 3));
          if (target !== current) {
            ops.push(
              pick(sessionsAdmin).rpc("stock_adjust", {
                p_client_request_id: randomUUID(),
                p_material_id: m,
                p_location_id: l,
                p_target_quantity: target,
                p_expected_current: current,
                p_reason_code: target < current ? "ZAGINIECIE" : "ZNALEZIONE",
              }),
            );
          }
        } else ops.push(asAdmin.rpc("stock_receipt", { p_client_request_id: randomUUID(), p_location_id: l, p_material_id: m, p_quantity: 2 }));
      }
      opCount += ops.length;
      const results = await Promise.all(ops);
      for (const r of results) if (r.error) codes.push(r.error.hint ?? r.error.code ?? "?");
    }

    expect(opCount).toBeGreaterThan(50);
    // Brak zakleszczeń i błędów nieoczekiwanych (wyłącznie błędy domenowe).
    expect(codes).not.toContain("40P01");
    const allowed = new Set(["RESERVED_STOCK", "INSUFFICIENT_STOCK", "ORDER_NOT_OPEN", "NOTHING_TO_RELEASE", "RELEASE_EXCEEDS", "STOCK_CHANGED", "NO_CHANGE"]);
    expect(codes.filter((c) => !allowed.has(c))).toEqual([]);
    // Spójność: rezerwacja = Σ zdarzeń; zamknięte zlecenia bez rezerwacji; stany ≥ 0 i zgodne z historią.
    for (const m of mats) await sumEventsMatches(m);
    const closed = await admin.from("production_orders").select("id").in("id", orders).in("status", ["DONE", "CANCELLED"]);
    const closedIds = (closed.data ?? []).map((x) => x.id as string);
    if (closedIds.length > 0) {
      const left = await admin.from("reservations").select("id").in("production_order_id", closedIds).gt("quantity", 0);
      expect(left.data).toEqual([]);
    }
    const neg = await admin.from("stock").select("quantity").in("material_id", mats).lt("quantity", 0);
    expect(neg.data).toEqual([]);
    await verify(mats);
  });
});
