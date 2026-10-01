import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getOrderIssueSummary, listRecentOrdersForUser } from "@/server/orders";
import { createIssue, createTransfer, listMovements, listMyRecentOperations } from "@/server/stock";
import { adminClient, createTestUser, deleteAllTestUsers, signIn, type TestUser } from "./helpers";

// Wydania i przesunięcia na bazie dev (Etap 5, ADR 010): role, poprawność, zlecenie XOR powód, idempotencja,
// współbieżność (stan nigdy < 0, brak zakleszczeń), nieaktywne lokalizacje, zamykanie zlecenia w trakcie wydania.
// Dane: materiały is_test (klucz secret) z prefiksem TEST-<runId>-; sprzątanie przez purge_test_stock.

const admin = adminClient();
const RUN = randomBytes(4).toString("hex").toUpperCase();
const P = `TEST-${RUN}`;
const dbUrl = process.env.SUPABASE_DB_URL;
let sql: postgres.Sql;

let tAdmin: TestUser;
let tBiuro: TestUser;
let tProd: TestUser;
let tProd2: TestUser;
let asAdmin: SupabaseClient;
let asBiuro: SupabaseClient;
let asProd: SupabaseClient;
let asProd2: SupabaseClient;
let asProdB: SupabaseClient;
let asProd2B: SupabaseClient;
let sessions: SupabaseClient[]; // osobne sesje/klienty (każde żądanie = osobne połączenie PostgREST)

const ids = { category: "", order: "", orderDone: "", orderCancelled: "", orderRace: "", orderRace2: "" };
const testMaterials: string[] = [];
const testLocations: string[] = [];

async function material(code: string, unit = "szt.", extra: Record<string, unknown> = {}) {
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
  testLocations.push(data.id as string);
  return data.id as string;
}

async function order(name: string, status = "OPEN") {
  const { data, error } = await asBiuro.from("production_orders").insert({ name: `${P}-${name}` }).select("id").single();
  if (error) throw error;
  if (status !== "OPEN") {
    const upd = await asBiuro.from("production_orders").update({ status }).eq("id", data.id);
    if (upd.error) throw upd.error;
  }
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

type IssueArgs = {
  p_client_request_id?: string;
  p_location_id: string;
  p_material_id: string;
  p_quantity: number | string;
  p_production_order_id?: string | null;
  p_reason_code?: string | null;
  p_reason?: string | null;
  p_note?: string | null;
};
const issue = (client: SupabaseClient, args: IssueArgs) =>
  client.rpc("stock_issue", { p_client_request_id: randomUUID(), ...args });

type TransferArgs = {
  p_client_request_id?: string;
  p_material_id: string;
  p_from_location_id: string;
  p_to_location_id: string;
  p_quantity: number | string;
  p_note?: string | null;
};
const transfer = (client: SupabaseClient, args: TransferArgs) =>
  client.rpc("stock_transfer", { p_client_request_id: randomUUID(), ...args });

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
  const { data, error } = await admin.rpc("verify_stock", { p_material_ids: testMaterials });
  expect(error).toBeNull();
  expect(data).toEqual([]);
}

/** SQL jako użytkownik aplikacji (rola authenticated + claims JWT), w transakcji połączenia `tx`. */
async function actAs(tx: postgres.TransactionSql, userId: string) {
  await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`;
  await tx.unsafe("set local role authenticated");
}

/** Dwie transakcje: A wykonuje `first` i czeka (trzyma blokady); B (`second`) musi czekać; po zwolnieniu A wynik B. */
async function holdThenRun(
  first: (tx: postgres.TransactionSql) => Promise<unknown>,
  second: (tx: postgres.TransactionSql) => Promise<unknown>,
) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let started!: () => void;
  const firstDone = new Promise<void>((r) => (started = r));
  const txA = sql.begin(async (tx) => {
    await first(tx);
    started();
    await gate;
  });
  await firstDone;
  let settled = false;
  const txB = sql
    .begin(second)
    .then(
      () => ({ hint: "COMMITTED" as string | undefined, code: undefined as string | undefined }),
      (e: { hint?: string; code?: string }) => ({ hint: e.hint, code: e.code }),
    )
    .finally(() => (settled = true));
  await new Promise((r) => setTimeout(r, 1500));
  const waited = !settled;
  release();
  await txA;
  return { waited, second: await txB };
}

beforeAll(async () => {
  if (!dbUrl) throw new Error("Brak SUPABASE_DB_URL w .env.scripts");
  sql = postgres(dbUrl, { max: 4, prepare: false, onnotice: () => {} });
  await deleteAllTestUsers(admin);
  tAdmin = await createTestUser(admin, "ADMIN");
  tBiuro = await createTestUser(admin, "BIURO");
  tProd = await createTestUser(admin, "PRODUKCJA");
  tProd2 = await createTestUser(admin, "PRODUKCJA", "produkcja2");
  [asAdmin, asBiuro, asProd, asProd2, asProdB, asProd2B] = await Promise.all([
    signIn(tAdmin),
    signIn(tBiuro),
    signIn(tProd),
    signIn(tProd2),
    signIn(tProd),
    signIn(tProd2),
  ]);
  sessions = [asProd, asProd2, asAdmin, asProdB, asProd2B];

  const cat = await asAdmin.from("material_categories").insert({ name: `${P}-kat` }).select("id").single();
  if (cat.error) throw cat.error;
  ids.category = cat.data.id;
  ids.order = await order("Kowalski");
  ids.orderDone = await order("Zakonczone", "DONE");
  ids.orderCancelled = await order("Anulowane", "CANCELLED");
  ids.orderRace = await order("Wyscig");
  ids.orderRace2 = await order("Wyscig2");
});

afterAll(async () => {
  try {
    const purge = await admin.rpc("purge_test_stock", { p_material_ids: testMaterials });
    if (purge.error) console.warn("purge_test_stock:", purge.error.message);
    await admin.from("production_orders").delete().like("name", `${P}-%`);
    await admin.from("materials").delete().like("code", `${P}-%`);
    await admin.from("locations").delete().like("code", `${P}-%`);
    await admin.from("material_categories").delete().like("name", `${P}-%`);
  } finally {
    await sql?.end();
    await deleteAllTestUsers(admin);
  }
});

// ---------------------------------------------------------------------------
describe("stock_issue — role i poprawność", () => {
  let m: string;
  let mb: string;
  let a: string;
  beforeAll(async () => {
    m = await material("ISS");
    mb = await material("ISSMB", "mb");
    a = await location("ISS-A");
    await receive(m, a, 10);
    await receive(mb, a, 5.5);
  });

  it("BIURO → 42501, nic nie zmieniono", async () => {
    const r = await issue(asBiuro, { p_location_id: a, p_material_id: m, p_quantity: 1, p_production_order_id: ids.order });
    expect(r.error?.code).toBe("42501");
    expect(await stockQty(m, a)).toBe(10);
  });

  it("wydanie na zlecenie: zmniejsza stan, operacja ISSUE + ruch −qty z autorem i zleceniem", async () => {
    const crid = randomUUID();
    const r = await asProd.rpc("stock_issue", {
      p_client_request_id: crid,
      p_location_id: a,
      p_material_id: m,
      p_quantity: 3,
      p_production_order_id: ids.order,
      p_note: "  na okna ",
    });
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ quantity: 3, remaining_location_quantity: 7, idempotent_replay: false, production_order_id: ids.order });
    expect(await stockQty(m, a)).toBe(7);
    const op = await admin.from("stock_operations").select("*").eq("client_request_id", crid).single();
    expect(op.data).toMatchObject({ type: "ISSUE", user_id: tProd.id, production_order_id: ids.order, reason_code: null, reason: null, note: "na okna" });
    const mv = await admin.from("stock_movements").select("*").eq("operation_id", op.data!.id);
    expect(mv.data).toHaveLength(1);
    expect(mv.data![0]).toMatchObject({ material_id: m, location_id: a, user_id: tProd.id });
    expect(Number(mv.data![0].quantity_delta)).toBe(-3);
    await expectConsistent();
  });

  it("wydanie z powodem (bez zlecenia) i INNY z opisem", async () => {
    const s = await issue(asProd, { p_location_id: a, p_material_id: m, p_quantity: 1, p_reason_code: "SERWIS" });
    expect(s.error).toBeNull();
    const o = await issue(asProd, { p_location_id: a, p_material_id: m, p_quantity: 1, p_reason_code: "INNY", p_reason: "  pokaz dla klienta " });
    expect(o.error).toBeNull();
    const op = await admin.from("stock_operations").select("reason_code, reason, production_order_id").eq("id", o.data.operation_id).single();
    expect(op.data).toEqual({ reason_code: "INNY", reason: "pokaz dla klienta", production_order_id: null });
    expect(await stockQty(m, a)).toBe(5);
  });

  it("ułamki: mb 2,25 OK; szt. 0,5 → NOT_INTEGER", async () => {
    expect((await issue(asProd, { p_location_id: a, p_material_id: mb, p_quantity: "2.25", p_reason_code: "PROBKA" })).error).toBeNull();
    expect(await stockQty(mb, a)).toBe(3.25);
    const r = await issue(asProd, { p_location_id: a, p_material_id: m, p_quantity: 0.5, p_reason_code: "PROBKA" });
    expect(r.error?.hint).toBe("NOT_INTEGER");
  });

  it.each([
    ["ani zlecenia, ani powodu", {}, "ISSUE_TARGET"],
    ["zlecenie i powód naraz", { p_production_order_id: "ORDER", p_reason_code: "SERWIS" }, "ISSUE_TARGET"],
    ["opis przy zleceniu", { p_production_order_id: "ORDER", p_reason: "x" }, "ISSUE_TARGET"],
    ["INNY bez opisu", { p_reason_code: "INNY" }, "REASON_REQUIRED"],
    ["INNY z pustym opisem", { p_reason_code: "INNY", p_reason: "   " }, "REASON_REQUIRED"],
    ["nieznany powód", { p_reason_code: "KRADZIEZ" }, "VALIDATION"],
    ["opis > 200", { p_reason_code: "INNY", p_reason: "x".repeat(201) }, "VALIDATION"],
    ["zlecenie zakończone", { p_production_order_id: "DONE" }, "ORDER_NOT_OPEN"],
    ["zlecenie anulowane", { p_production_order_id: "CANCELLED" }, "ORDER_NOT_OPEN"],
    ["zlecenie nie istnieje", { p_production_order_id: "MISSING" }, "NOT_FOUND"],
    ["ilość 0", { p_reason_code: "SERWIS", p_quantity: 0 }, "INVALID_QUANTITY"],
    ["ilość ujemna", { p_reason_code: "SERWIS", p_quantity: -1 }, "INVALID_QUANTITY"],
    ["skala 4", { p_reason_code: "SERWIS", p_quantity: "1.0001" }, "INVALID_QUANTITY"],
    ["więcej niż stan", { p_reason_code: "SERWIS", p_quantity: 999 }, "INSUFFICIENT_STOCK"],
    ["lokalizacja nie istnieje", { p_reason_code: "SERWIS", p_location_id: "MISSING" }, "NOT_FOUND"],
    ["materiał nie istnieje", { p_reason_code: "SERWIS", p_material_id: "MISSING" }, "NOT_FOUND"],
  ] as [string, Record<string, unknown>, string][])("%s → %s, bez zmian", async (_n, override, hint) => {
    const map: Record<string, string> = {
      ORDER: ids.order,
      DONE: ids.orderDone,
      CANCELLED: ids.orderCancelled,
      MISSING: randomUUID(),
    };
    const args = { p_location_id: a, p_material_id: m, p_quantity: 1, ...override } as Record<string, unknown>;
    for (const k of ["p_production_order_id", "p_location_id", "p_material_id"]) {
      if (typeof args[k] === "string" && (args[k] as string) in map) args[k] = map[args[k] as string];
    }
    const before = await stockQty(m, a);
    const r = await issue(asProd, args as IssueArgs);
    expect(r.error?.code).toBe("P0001");
    expect(r.error?.hint).toBe(hint);
    expect(await stockQty(m, a)).toBe(before);
  });

  it("INSUFFICIENT_STOCK: detail = dostępna ilość; serwis → 409 z details.available", async () => {
    const r = await issue(asProd, { p_location_id: a, p_material_id: m, p_quantity: 6, p_reason_code: "SERWIS" });
    expect(r.error?.hint).toBe("INSUFFICIENT_STOCK");
    expect(Number(r.error?.details)).toBe(5);
    const s = await createIssue(asProd, { client_request_id: randomUUID(), location_id: a, material_id: m, quantity: 6, reason_code: "SERWIS" });
    expect(s.ok ? null : s.error).toMatchObject({ status: 409, code: "INSUFFICIENT_STOCK", details: { available: 5 } });
    // Brak wiersza stanu (materiał nigdy nie był w tej lokalizacji) → dostępne 0.
    const empty = await location("IE");
    const e = await issue(asProd, { p_location_id: empty, p_material_id: m, p_quantity: 1, p_reason_code: "SERWIS" });
    expect(e.error?.hint).toBe("INSUFFICIENT_STOCK");
    expect(Number(e.error?.details)).toBe(0);
  });

  it("wydanie do zera: stan 0, CHECK nigdy < 0; verify_stock = 0", async () => {
    const r = await issue(asProd, { p_location_id: a, p_material_id: m, p_quantity: 5, p_production_order_id: ids.order });
    expect(r.error).toBeNull();
    expect(r.data.remaining_location_quantity).toBe(0);
    expect(await stockQty(m, a)).toBe(0);
    await expectConsistent();
  });

  it("wydanie z NIEAKTYWNEJ lokalizacji i z nieaktywnego materiału — dozwolone (ADR 010)", async () => {
    const m2 = await material("ISSOFF");
    const off = await location("IO");
    await receive(m2, off, 2);
    // Dezaktywacja wymaga zera, więc wymuszamy scenariusz: wydanie 2 → 0, dezaktywacja, potem próba wydania.
    expect((await issue(asProd, { p_location_id: off, p_material_id: m2, p_quantity: 2, p_reason_code: "SERWIS" })).error).toBeNull();
    expect((await asAdmin.from("locations").update({ active: false }).eq("id", off)).error).toBeNull();
    expect((await asAdmin.from("materials").update({ active: false }).eq("id", m2)).error).toBeNull();
    const r = await issue(asProd, { p_location_id: off, p_material_id: m2, p_quantity: 1, p_reason_code: "SERWIS" });
    // Nie LOCATION_INACTIVE / MATERIAL_INACTIVE — tylko brak stanu.
    expect(r.error?.hint).toBe("INSUFFICIENT_STOCK");
  });
});

// ---------------------------------------------------------------------------
describe("stock_transfer — poprawność", () => {
  let m: string;
  let a: string;
  let b: string;
  let off: string;
  beforeAll(async () => {
    m = await material("TR");
    a = await location("TR-A");
    b = await location("TR-B");
    off = await location("TR-OFF");
    await asAdmin.from("locations").update({ active: false }).eq("id", off);
    await receive(m, a, 10);
  });

  it("A → B: operacja TRANSFER + dwa ruchy (−A, +B), stany obu lokalizacji", async () => {
    const crid = randomUUID();
    const r = await asProd.rpc("stock_transfer", {
      p_client_request_id: crid,
      p_material_id: m,
      p_from_location_id: a,
      p_to_location_id: b,
      p_quantity: 4,
    });
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ quantity: 4, from_location_quantity: 6, to_location_quantity: 4, idempotent_replay: false });
    const op = await admin.from("stock_operations").select("*").eq("client_request_id", crid).single();
    expect(op.data).toMatchObject({ type: "TRANSFER", user_id: tProd.id, production_order_id: null, reason_code: null });
    const mv = await admin.from("stock_movements").select("location_id, quantity_delta").eq("operation_id", op.data!.id);
    expect(mv.data!.map((x) => [x.location_id, Number(x.quantity_delta)]).sort()).toEqual([[a, -4], [b, 4]].sort());
    expect(await stockQty(m, a)).toBe(6);
    expect(await stockQty(m, b)).toBe(4);
    await expectConsistent();
  });

  it.each([
    ["skąd = dokąd", { to: "A" }, "SAME_LOCATION"],
    ["docelowa nieaktywna", { to: "OFF" }, "LOCATION_INACTIVE"],
    ["docelowa nie istnieje", { to: "MISSING" }, "NOT_FOUND"],
    ["więcej niż stan", { qty: 7 }, "INSUFFICIENT_STOCK"],
    ["ilość 0", { qty: 0 }, "INVALID_QUANTITY"],
    ["ułamek dla szt.", { qty: 0.5 }, "NOT_INTEGER"],
  ] as [string, { to?: string; qty?: number }, string][])("%s → %s", async (_n, o, hint) => {
    const map: Record<string, string> = { A: a, OFF: off, MISSING: randomUUID() };
    const r = await transfer(asProd, {
      p_material_id: m,
      p_from_location_id: a,
      p_to_location_id: o.to ? map[o.to] : b,
      p_quantity: o.qty ?? 1,
    });
    expect(r.error?.hint).toBe(hint);
    expect(await stockQty(m, a)).toBe(6);
  });

  it("ze źródłowej NIEAKTYWNEJ — dozwolone (opróżnienie miejsca)", async () => {
    // B ma 4; przenosimy wszystko do A, dezaktywujemy B... nie można (musi być pusta) — więc: opróżnij B, dezaktywuj,
    // przyjęcie do nieaktywnej jest zabronione — stan w nieaktywnej mógł zostać tylko sprzed dezaktywacji, czyli 0.
    // Sprawdzamy więc, że funkcja NIE odrzuca nieaktywnej źródłowej kodem LOCATION_INACTIVE.
    const r = await transfer(asProd, { p_material_id: m, p_from_location_id: off, p_to_location_id: a, p_quantity: 1 });
    expect(r.error?.hint).toBe("INSUFFICIENT_STOCK");
  });

  it("BIURO → 42501", async () => {
    const r = await transfer(asBiuro, { p_material_id: m, p_from_location_id: a, p_to_location_id: b, p_quantity: 1 });
    expect(r.error?.code).toBe("42501");
  });

  it("serwis createTransfer: camelCase, 409 z dostępną ilością", async () => {
    const ok = await createTransfer(asProd, { client_request_id: randomUUID(), material_id: m, from_location_id: b, to_location_id: a, quantity: 1 });
    expect(ok.ok && ok.data).toMatchObject({ quantity: 1, fromLocationQuantity: 3, toLocationQuantity: 7, idempotentReplay: false });
    const bad = await createTransfer(asProd, { client_request_id: randomUUID(), material_id: m, from_location_id: b, to_location_id: a, quantity: 50 });
    expect(bad.ok ? null : bad.error).toMatchObject({ status: 409, code: "INSUFFICIENT_STOCK", details: { available: 3 } });
    await expectConsistent();
  });
});

// ---------------------------------------------------------------------------
describe("idempotencja wydania i przesunięcia", () => {
  let m: string;
  let a: string;
  let b: string;
  beforeAll(async () => {
    m = await material("IDEM");
    a = await location("IDEM-A");
    b = await location("IDEM-B");
    await receive(m, a, 20);
  });

  it("wydanie: ten sam id 5× równolegle → 1 operacja, 1 ruch, stan zmniejszony raz", async () => {
    const args = { p_client_request_id: randomUUID(), p_location_id: a, p_material_id: m, p_quantity: 3, p_production_order_id: ids.order };
    const results = await Promise.all([asProd, asProdB, asProd, asProdB, asProd].map((s) => s.rpc("stock_issue", args)));
    for (const r of results) expect(r.error).toBeNull();
    const replays = results.map((r) => r.data.idempotent_replay);
    expect(replays.filter((x) => !x)).toHaveLength(1);
    expect(new Set(results.map((r) => r.data.operation_id)).size).toBe(1);
    expect(await stockQty(m, a)).toBe(17);
    const ops = await admin.from("stock_operations").select("id").eq("client_request_id", args.p_client_request_id);
    expect(ops.data).toHaveLength(1);
  });

  it("przesunięcie: ten sam id 5× równolegle → 1 operacja, 2 ruchy", async () => {
    const args = { p_client_request_id: randomUUID(), p_material_id: m, p_from_location_id: a, p_to_location_id: b, p_quantity: 2 };
    const results = await Promise.all([asProd, asProdB, asProd, asProdB, asProd].map((s) => s.rpc("stock_transfer", args)));
    for (const r of results) expect(r.error).toBeNull();
    expect(results.filter((r) => !r.data.idempotent_replay)).toHaveLength(1);
    const ops = await admin.from("stock_operations").select("id").eq("client_request_id", args.p_client_request_id);
    expect(ops.data).toHaveLength(1);
    const mv = await admin.from("stock_movements").select("id").eq("operation_id", ops.data![0].id);
    expect(mv.data).toHaveLength(2);
    expect(await stockQty(m, a)).toBe(15);
    expect(await stockQty(m, b)).toBe(2);
    await expectConsistent();
  });

  it("ten sam id z innymi parametrami / od innego użytkownika / dla innego typu → IDEMPOTENCY_CONFLICT", async () => {
    const crid = randomUUID();
    const args = { p_client_request_id: crid, p_location_id: a, p_material_id: m, p_quantity: 1, p_reason_code: "SERWIS" };
    expect((await asProd.rpc("stock_issue", args)).error).toBeNull();
    for (const changed of [
      { p_quantity: 2 },
      { p_reason_code: "PROBKA" },
      { p_reason_code: null, p_production_order_id: ids.order },
      { p_note: "inna" },
    ]) {
      const r = await asProd.rpc("stock_issue", { ...args, ...changed });
      expect(r.error?.hint, JSON.stringify(changed)).toBe("IDEMPOTENCY_CONFLICT");
    }
    expect((await asProd2.rpc("stock_issue", args)).error?.hint).toBe("IDEMPOTENCY_CONFLICT");
    const asTransfer = await asProd.rpc("stock_transfer", {
      p_client_request_id: crid,
      p_material_id: m,
      p_from_location_id: a,
      p_to_location_id: b,
      p_quantity: 1,
    });
    expect(asTransfer.error?.hint).toBe("IDEMPOTENCY_CONFLICT");
    // Replay po zamknięciu zlecenia nadal zwraca wynik (operacja już się odbyła).
    const ord = await order("Replay");
    const rArgs = { p_client_request_id: randomUUID(), p_location_id: a, p_material_id: m, p_quantity: 1, p_production_order_id: ord };
    expect((await asProd.rpc("stock_issue", rArgs)).error).toBeNull();
    await asBiuro.from("production_orders").update({ status: "DONE" }).eq("id", ord);
    const replay = await asProd.rpc("stock_issue", rArgs);
    expect(replay.error).toBeNull();
    expect(replay.data.idempotent_replay).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("współbieżność", () => {
  it("stan 10, 5 równoległych wydań po 3 (osobne sesje) → dokładnie 3 sukcesy, 2× INSUFFICIENT_STOCK, stan 1", async () => {
    const m = await material("CONC3");
    const a = await location("C3A");
    await receive(m, a, 10);
    const results = await Promise.all(
      sessions.map((s) => issue(s, { p_location_id: a, p_material_id: m, p_quantity: 3, p_production_order_id: ids.order })),
    );
    const ok = results.filter((r) => !r.error);
    const insufficient = results.filter((r) => r.error?.hint === "INSUFFICIENT_STOCK");
    expect(ok).toHaveLength(3);
    expect(insufficient).toHaveLength(2);
    expect(await stockQty(m, a)).toBe(1);
    // Każde odrzucenie widziało stan po zatwierdzonych wydaniach (1).
    for (const r of insufficient) expect(Number(r.error?.details)).toBe(1);
    expect(ok.map((r) => r.data.remaining_location_quantity).sort()).toEqual([1, 4, 7]);
    await expectConsistent();
  });

  it("stan N=15, 25 równoległych wydań po 1 → dokładnie 15 sukcesów, stan 0", async () => {
    const m = await material("CONC1");
    const a = await location("C1A");
    await receive(m, a, 15);
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        issue(sessions[i % sessions.length], { p_location_id: a, p_material_id: m, p_quantity: 1, p_reason_code: "ZUZYCIE_WLASNE" }),
      ),
    );
    expect(results.filter((r) => !r.error)).toHaveLength(15);
    expect(results.filter((r) => r.error?.hint === "INSUFFICIENT_STOCK")).toHaveLength(10);
    expect(results.filter((r) => r.error && r.error.hint !== "INSUFFICIENT_STOCK")).toHaveLength(0);
    expect(await stockQty(m, a)).toBe(0);
    await expectConsistent();
  });

  it("przesunięcia A→B i B→A równolegle (40×) → brak zakleszczenia, suma stała, verify_stock = 0", async () => {
    const m = await material("PINGPONG");
    const a = await location("PP-A");
    const b = await location("PP-B");
    await receive(m, a, 20);
    await receive(m, b, 20);
    const started = Date.now();
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        transfer(sessions[i % sessions.length], {
          p_material_id: m,
          p_from_location_id: i % 2 === 0 ? a : b,
          p_to_location_id: i % 2 === 0 ? b : a,
          p_quantity: 1,
        }),
      ),
    );
    for (const r of results) expect(r.error, JSON.stringify(r.error)).toBeNull(); // 40P01 (deadlock) byłby błędem
    expect(Date.now() - started).toBeLessThan(25_000);
    expect((await stockQty(m, a)) + (await stockQty(m, b))).toBe(40);
    expect(await stockQty(m, a)).toBe(20); // 20 w każdą stronę
    await expectConsistent();
  });

  it("przesunięcia dwóch materiałów w przeciwnych kierunkach równolegle → brak zakleszczenia", async () => {
    const m1 = await material("X1");
    const m2 = await material("X2");
    const a = await location("X-A");
    const b = await location("X-B");
    await receive(m1, a, 10);
    await receive(m2, b, 10);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        transfer(sessions[i % sessions.length], {
          p_material_id: i % 2 === 0 ? m1 : m2,
          p_from_location_id: i % 2 === 0 ? a : b,
          p_to_location_id: i % 2 === 0 ? b : a,
          p_quantity: 1,
        }),
      ),
    );
    for (const r of results) expect(r.error).toBeNull();
    expect(await stockQty(m1, b)).toBe(10);
    expect(await stockQty(m2, a)).toBe(10);
    await expectConsistent();
  });

  it("przesunięcia z A równolegle z wydaniami z A → łącznie dokładnie 10 udanych, stan A = 0, nigdy < 0", async () => {
    const m = await material("MIX");
    const a = await location("MIX-A");
    const b = await location("MIX-B");
    await receive(m, a, 10);
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        i % 2 === 0
          ? transfer(sessions[i % sessions.length], { p_material_id: m, p_from_location_id: a, p_to_location_id: b, p_quantity: 1 })
          : issue(sessions[i % sessions.length], { p_location_id: a, p_material_id: m, p_quantity: 1, p_reason_code: "SERWIS" }),
      ),
    );
    expect(results.filter((r) => !r.error)).toHaveLength(10);
    expect(results.filter((r) => r.error && r.error.hint !== "INSUFFICIENT_STOCK")).toHaveLength(0);
    expect(await stockQty(m, a)).toBe(0);
    const transferred = results.filter((r, i) => i % 2 === 0 && !r.error).length;
    expect(await stockQty(m, b)).toBe(transferred);
    await expectConsistent();
  });

  it("przesunięcie w toku blokuje dezaktywację lokalizacji docelowej; po zatwierdzeniu → LOCATION_NOT_EMPTY", async () => {
    const m = await material("DEACT");
    const a = await location("DA-A");
    const b = await location("DA-B");
    await receive(m, a, 5);
    const { waited, second } = await holdThenRun(
      async (tx) => {
        await actAs(tx, tProd.id);
        await tx`select public.stock_transfer(${randomUUID()}::uuid, ${m}::uuid, ${a}::uuid, ${b}::uuid, 2::numeric)`;
      },
      async (tx) => {
        await actAs(tx, tAdmin.id);
        await tx`update public.locations set active = false where id = ${b}`;
      },
    );
    expect(waited).toBe(true);
    expect(second.hint).toBe("LOCATION_NOT_EMPTY");
    const loc = await admin.from("locations").select("active").eq("id", b).single();
    expect(loc.data?.active).toBe(true);
    expect(await stockQty(m, b)).toBe(2);
    await expectConsistent();
  });

  it("dezaktywacja lokalizacji docelowej w toku blokuje przesunięcie; po zatwierdzeniu → LOCATION_INACTIVE", async () => {
    const m = await material("DEACT2");
    const a = await location("DB-A");
    const b = await location("DB-B");
    await receive(m, a, 5);
    const { waited, second } = await holdThenRun(
      async (tx) => {
        await actAs(tx, tAdmin.id);
        await tx`update public.locations set active = false where id = ${b}`;
      },
      async (tx) => {
        await actAs(tx, tProd.id);
        await tx`select public.stock_transfer(${randomUUID()}::uuid, ${m}::uuid, ${a}::uuid, ${b}::uuid, 2::numeric)`;
      },
    );
    expect(waited).toBe(true);
    expect(second.hint).toBe("LOCATION_INACTIVE");
    expect(await stockQty(m, a)).toBe(5);
    expect(await stockQty(m, b)).toBe(0);
  });

  it("wydanie w toku na zlecenie: zamknięcie zlecenia czeka, potem przechodzi (DONE po wydaniu)", async () => {
    const m = await material("ORD1");
    const a = await location("ORD1-A");
    await receive(m, a, 5);
    const { waited, second } = await holdThenRun(
      async (tx) => {
        await actAs(tx, tProd.id);
        await tx`select public.stock_issue(${randomUUID()}::uuid, ${a}::uuid, ${m}::uuid, 2::numeric, ${ids.orderRace}::uuid)`;
      },
      async (tx) => {
        await actAs(tx, tBiuro.id);
        await tx`update public.production_orders set status = 'DONE' where id = ${ids.orderRace}`;
      },
    );
    expect(waited).toBe(true);
    expect(second.hint).toBe("COMMITTED");
    expect(await stockQty(m, a)).toBe(3);
    const o = await admin.from("production_orders").select("status").eq("id", ids.orderRace).single();
    expect(o.data?.status).toBe("DONE");
    // Kolejne wydanie na zamknięte zlecenie → odmowa.
    const r = await issue(asProd, { p_location_id: a, p_material_id: m, p_quantity: 1, p_production_order_id: ids.orderRace });
    expect(r.error?.hint).toBe("ORDER_NOT_OPEN");
  });

  it("zamykanie zlecenia w toku: wydanie czeka, potem ORDER_NOT_OPEN (bez zmian stanu)", async () => {
    const m = await material("ORD2");
    const a = await location("ORD2-A");
    await receive(m, a, 5);
    const { waited, second } = await holdThenRun(
      async (tx) => {
        await actAs(tx, tBiuro.id);
        await tx`update public.production_orders set status = 'CANCELLED' where id = ${ids.orderRace2}`;
      },
      async (tx) => {
        await actAs(tx, tProd.id);
        await tx`select public.stock_issue(${randomUUID()}::uuid, ${a}::uuid, ${m}::uuid, 2::numeric, ${ids.orderRace2}::uuid)`;
      },
    );
    expect(waited).toBe(true);
    expect(second.hint).toBe("ORDER_NOT_OPEN");
    expect(await stockQty(m, a)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
describe("odczyty: lista operacji, moje ostatnie, zlecenia", () => {
  it("list_stock_movements: ISSUE ze zleceniem/powodem, filtr zlecenia; TRANSFER zwinięty (skąd → dokąd)", async () => {
    const issues = await listMovements(asBiuro, { type: "ISSUE", q: `${P}-ISS`, page: 1, pageSize: 100 });
    expect(issues.ok).toBe(true);
    if (!issues.ok) return;
    const withOrder = issues.data.items.find((i) => i.productionOrderId === ids.order);
    expect(withOrder).toMatchObject({ productionOrderName: `${P}-Kowalski`, reasonCode: null, userName: "Test PRODUKCJA" });
    expect(withOrder!.quantityDelta).toBeLessThan(0);
    const other = issues.data.items.find((i) => i.reasonCode === "INNY");
    expect(other).toMatchObject({ reason: "pokaz dla klienta", productionOrderId: null });

    const byOrder = await listMovements(asBiuro, { type: "ISSUE", orderId: ids.order, page: 1, pageSize: 100 });
    expect(byOrder.ok && byOrder.data.items.every((i) => i.productionOrderId === ids.order)).toBe(true);

    const tr = await listMovements(asBiuro, { type: "TRANSFER", q: `${P}-TR`, page: 1, pageSize: 100 }, { collapseTransfers: true });
    expect(tr.ok).toBe(true);
    if (!tr.ok) return;
    expect(tr.data.items.every((i) => i.quantityDelta > 0)).toBe(true);
    expect(tr.data.items.find((i) => i.fromLocationCode === `${P}-TR-A`)).toMatchObject({ toLocationCode: `${P}-TR-B` });
    const full = await listMovements(asBiuro, { type: "TRANSFER", q: `${P}-TR`, page: 1, pageSize: 100 });
    expect(full.ok && full.data.total).toBe(2 * tr.data.total);
  });

  it("PRODUKCJA: tylko własne operacje; moje ostatnie (przyjęcia, wydania, przesunięcia)", async () => {
    const list = await listMovements(asProd2, { type: "ISSUE", q: P, page: 1, pageSize: 100 });
    expect(list.ok).toBe(true);
    const { count } = await admin
      .from("stock_movements")
      .select("id, operation:stock_operations!inner(type)", { count: "exact", head: true })
      .eq("user_id", tProd2.id)
      .eq("operation.type", "ISSUE")
      .in("material_id", testMaterials);
    if (list.ok) expect(list.data.total).toBe(count);

    const mine = await listMyRecentOperations(asProd, tProd.id, { since: new Date(Date.now() - 3_600_000).toISOString(), limit: 300 });
    expect(mine.ok).toBe(true);
    if (!mine.ok) return;
    const types = new Set(mine.data.map((o) => o.type));
    expect(types.has("ISSUE")).toBe(true);
    expect(types.has("TRANSFER")).toBe(true);
    const t = mine.data.find((o) => o.type === "TRANSFER" && o.toLocationCode === `${P}-TR-B`);
    expect(t).toMatchObject({ locationCode: `${P}-TR-A`, quantity: 4 });
    const i = mine.data.find((o) => o.type === "ISSUE" && o.orderName === `${P}-Kowalski`);
    expect(i?.quantity).toBeGreaterThan(0);
  });

  it("ostatnio używane otwarte zlecenia i podsumowanie wydań na zlecenie", async () => {
    const recent = await listRecentOrdersForUser(asProd, tProd.id);
    expect(recent.ok && recent.data.map((o) => o.id)).toContain(ids.order);
    expect(recent.ok && recent.data.every((o) => o.status === "OPEN")).toBe(true);
    const summary = await getOrderIssueSummary(asBiuro, ids.order);
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    const iss = summary.data.find((s) => s.materialCode === `${P}-ISS`);
    expect(iss).toMatchObject({ quantity: 8, issues: 2 }); // 3 + 5
    // SQL (SECURITY INVOKER): PRODUKCJA dostaje sumę wyłącznie własnych wydań (RLS).
    const own = await getOrderIssueSummary(asProd2, ids.order);
    expect(own.ok && own.data.find((s) => s.materialCode === `${P}-ISS`)).toBeFalsy();
  });

  it("końcowa spójność: verify_stock = 0", async () => {
    await expectConsistent();
  });
});
