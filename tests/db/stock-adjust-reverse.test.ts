import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getOrderIssueSummary } from "@/server/orders";
import { createAdjustment, createReversal, listMovements, listUserNames, verifyStock } from "@/server/stock";
import { adminClient, createTestUser, deleteAllTestUsers, signIn, type TestUser } from "./helpers";

// Etap 6 na bazie dev (ADR 011): korekta „ustaw stan na X” (ADMIN), storno (ADMIN), historia ruchów z filtrami,
// współbieżność (korekta vs wydanie, równoległe storna), idempotencja, sprzątanie testów (purge z stornami).
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
let asAdminB: SupabaseClient;
let asBiuro: SupabaseClient;
let asProd: SupabaseClient;
let asProd2: SupabaseClient;

const ids = { category: "", order: "" };
const testMaterials: string[] = [];

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

async function receive(materialId: string, locationId: string, qty: number, client: SupabaseClient = asAdmin) {
  const r = await client.rpc("stock_receipt", {
    p_client_request_id: randomUUID(),
    p_location_id: locationId,
    p_material_id: materialId,
    p_quantity: qty,
  });
  if (r.error) throw r.error;
  return r.data.operation_id as string;
}

type AdjustArgs = {
  p_client_request_id?: string;
  p_material_id: string;
  p_location_id: string;
  p_target_quantity: number | string;
  p_expected_current: number | string;
  p_reason_code?: string | null;
  p_reason?: string | null;
  p_note?: string | null;
};
const adjust = (client: SupabaseClient, args: AdjustArgs) =>
  client.rpc("stock_adjust", { p_client_request_id: randomUUID(), p_reason_code: "ZAGINIECIE", ...args });

const reverse = (client: SupabaseClient, operationId: string, reason = "pomyłka", crid = randomUUID()) =>
  client.rpc("stock_reverse", { p_client_request_id: crid, p_operation_id: operationId, p_reason: reason });

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

async function opCount(materialId: string, type?: string): Promise<number> {
  let q = admin
    .from("stock_movements")
    .select("id, operation:stock_operations!inner(type)", { count: "exact", head: true })
    .eq("material_id", materialId);
  if (type) q = q.eq("operation.type", type);
  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
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
      () => ({ hint: "COMMITTED" as string | undefined, code: undefined as string | undefined, detail: undefined as string | undefined }),
      (e: { hint?: string; code?: string; detail?: string }) => ({ hint: e.hint, code: e.code, detail: e.detail }),
    )
    .finally(() => (settled = true));
  await new Promise((r) => setTimeout(r, 1500));
  const waited = !settled;
  release();
  await txA;
  return { waited, second: await txB };
}

const warsawToday = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date());

beforeAll(async () => {
  if (!dbUrl) throw new Error("Brak SUPABASE_DB_URL w .env.scripts");
  sql = postgres(dbUrl, { max: 4, prepare: false, onnotice: () => {} });
  await deleteAllTestUsers(admin);
  tAdmin = await createTestUser(admin, "ADMIN");
  tBiuro = await createTestUser(admin, "BIURO");
  tProd = await createTestUser(admin, "PRODUKCJA");
  tProd2 = await createTestUser(admin, "PRODUKCJA", "produkcja2");
  [asAdmin, asAdminB, asBiuro, asProd, asProd2] = await Promise.all([
    signIn(tAdmin),
    signIn(tAdmin),
    signIn(tBiuro),
    signIn(tProd),
    signIn(tProd2),
  ]);
  const cat = await asAdmin.from("material_categories").insert({ name: `${P}-kat` }).select("id").single();
  if (cat.error) throw cat.error;
  ids.category = cat.data.id;
  const ord = await asBiuro.from("production_orders").insert({ name: `${P}-Nowak` }).select("id").single();
  if (ord.error) throw ord.error;
  ids.order = ord.data.id;
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
describe("stock_adjust — „ustaw stan na X”", () => {
  let m: string;
  let mb: string;
  let a: string;
  let b: string;
  beforeAll(async () => {
    m = await material("ADJ");
    mb = await material("ADJMB", "mb");
    a = await location("ADJ-A");
    b = await location("ADJ-B");
    await receive(m, a, 10);
  });

  it("w dół: operacja ADJUSTMENT + jeden ruch z różnicą, autor ADMIN, powód i notatka", async () => {
    const crid = randomUUID();
    const r = await asAdmin.rpc("stock_adjust", {
      p_client_request_id: crid,
      p_material_id: m,
      p_location_id: a,
      p_target_quantity: 7,
      p_expected_current: 10,
      p_reason_code: "USZKODZENIE",
      p_reason: "  zgniecione ",
      p_note: " regał ",
    });
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ previous_quantity: 10, quantity_delta: -3, new_quantity: 7, idempotent_replay: false });
    const op = await admin.from("stock_operations").select("*").eq("client_request_id", crid).single();
    expect(op.data).toMatchObject({
      type: "ADJUSTMENT",
      user_id: tAdmin.id,
      reason_code: "USZKODZENIE",
      reason: "zgniecione",
      note: "regał",
      production_order_id: null,
      reverses_operation_id: null,
    });
    const mv = await admin.from("stock_movements").select("*").eq("operation_id", op.data!.id);
    expect(mv.data).toHaveLength(1);
    expect(Number(mv.data![0].quantity_delta)).toBe(-3);
    expect(await stockQty(m, a)).toBe(7);
    await expectConsistent();
  });

  it("w górę, do zera, z zera (nowa lokalizacja), ułamki dla mb", async () => {
    expect((await adjust(asAdmin, { p_material_id: m, p_location_id: a, p_target_quantity: 12, p_expected_current: 7, p_reason_code: "ZNALEZIONE" })).error).toBeNull();
    expect(await stockQty(m, a)).toBe(12);
    expect((await adjust(asAdmin, { p_material_id: m, p_location_id: a, p_target_quantity: 0, p_expected_current: 12 })).error).toBeNull();
    expect(await stockQty(m, a)).toBe(0);
    const fromZero = await adjust(asAdmin, { p_material_id: m, p_location_id: b, p_target_quantity: 4, p_expected_current: 0, p_reason_code: "STAN_POCZATKOWY" });
    expect(fromZero.error).toBeNull();
    expect(fromZero.data).toMatchObject({ previous_quantity: 0, quantity_delta: 4, new_quantity: 4 });
    expect(await stockQty(m, b)).toBe(4);
    expect((await adjust(asAdmin, { p_material_id: mb, p_location_id: a, p_target_quantity: "2.125", p_expected_current: 0, p_reason_code: "STAN_POCZATKOWY" })).error).toBeNull();
    expect(await stockQty(mb, a)).toBe(2.125);
    await expectConsistent();
  });

  it("różnica 0 → NO_CHANGE, nic nie zapisano", async () => {
    const before = await opCount(m);
    const r = await adjust(asAdmin, { p_material_id: m, p_location_id: b, p_target_quantity: 4, p_expected_current: 4 });
    expect(r.error?.hint).toBe("NO_CHANGE");
    expect(await opCount(m)).toBe(before);
  });

  it("inny expected_current → STOCK_CHANGED z aktualnym stanem; nic nie zapisano; serwis → 409 details.current", async () => {
    const before = await opCount(m);
    const r = await adjust(asAdmin, { p_material_id: m, p_location_id: b, p_target_quantity: 1, p_expected_current: 5 });
    expect(r.error?.hint).toBe("STOCK_CHANGED");
    expect(Number(r.error?.details)).toBe(4);
    expect(await opCount(m)).toBe(before);
    expect(await stockQty(m, b)).toBe(4);
    const s = await createAdjustment(asAdmin, {
      client_request_id: randomUUID(),
      material_id: m,
      location_id: b,
      target_quantity: 1,
      expected_current: 5,
      reason_code: "ZAGINIECIE",
    });
    expect(s.ok ? null : s.error).toMatchObject({ status: 409, code: "STOCK_CHANGED", details: { current: 4 } });
  });

  it.each([
    ["INNY bez opisu", { p_reason_code: "INNY" }, "REASON_REQUIRED"],
    ["kod powodu wydania (SERWIS)", { p_reason_code: "SERWIS" }, "VALIDATION"],
    ["brak kodu powodu", { p_reason_code: null }, "VALIDATION"],
    ["target ujemny", { p_target_quantity: -1 }, "INVALID_QUANTITY"],
    ["target skala 4", { p_target_quantity: "1.0001" }, "INVALID_QUANTITY"],
    ["ułamek dla szt.", { p_target_quantity: 2.5 }, "NOT_INTEGER"],
    ["brak expected", { p_expected_current: null }, "VALIDATION"],
    ["materiał nie istnieje", { p_material_id: "MISSING" }, "NOT_FOUND"],
    ["lokalizacja nie istnieje", { p_location_id: "MISSING" }, "NOT_FOUND"],
  ] as [string, Record<string, unknown>, string][])("%s → %s, bez zmian", async (_n, override, hint) => {
    const args = { p_material_id: m, p_location_id: b, p_target_quantity: 2, p_expected_current: 4, ...override } as Record<string, unknown>;
    for (const k of ["p_material_id", "p_location_id"]) if (args[k] === "MISSING") args[k] = randomUUID();
    const r = await adjust(asAdmin, args as AdjustArgs);
    expect(r.error?.code).toBe("P0001");
    expect(r.error?.hint).toBe(hint);
    expect(await stockQty(m, b)).toBe(4);
  });

  it("INNY z opisem — OK", async () => {
    const r = await adjust(asAdmin, { p_material_id: m, p_location_id: b, p_target_quantity: 5, p_expected_current: 4, p_reason_code: "INNY", p_reason: "inwentura częściowa" });
    expect(r.error).toBeNull();
    expect(await stockQty(m, b)).toBe(5);
  });

  it("BIURO i PRODUKCJA → 42501 (także bezpośrednio przez Data API)", async () => {
    for (const c of [asBiuro, asProd]) {
      const r = await adjust(c, { p_material_id: m, p_location_id: b, p_target_quantity: 1, p_expected_current: 5 });
      expect(r.error?.code).toBe("42501");
    }
    expect(await stockQty(m, b)).toBe(5);
  });

  it("nieaktywna lokalizacja / materiał: w dół do 0 OK, w górę → LOCATION_INACTIVE / MATERIAL_INACTIVE", async () => {
    const mi = await material("ADJOFF");
    const off = await location("AOFF");
    await receive(mi, off, 3);
    // Dezaktywacja wymaga zera — wymuszamy: korekta do 0, dezaktywacja, potem próby.
    expect((await adjust(asAdmin, { p_material_id: mi, p_location_id: off, p_target_quantity: 0, p_expected_current: 3 })).error).toBeNull();
    expect((await asAdmin.from("locations").update({ active: false }).eq("id", off)).error).toBeNull();
    const up = await adjust(asAdmin, { p_material_id: mi, p_location_id: off, p_target_quantity: 1, p_expected_current: 0, p_reason_code: "ZNALEZIONE" });
    expect(up.error?.hint).toBe("LOCATION_INACTIVE");
    const act = await location("AACT");
    expect((await asAdmin.from("materials").update({ active: false }).eq("id", mi)).error).toBeNull();
    const upMat = await adjust(asAdmin, { p_material_id: mi, p_location_id: act, p_target_quantity: 1, p_expected_current: 0, p_reason_code: "ZNALEZIONE" });
    expect(upMat.error?.hint).toBe("MATERIAL_INACTIVE");
    expect(await stockQty(mi, off)).toBe(0);
    expect(await stockQty(mi, act)).toBe(0);
  });

  it("idempotencja: ten sam id 5× równolegle → 1 operacja; inne parametry → IDEMPOTENCY_CONFLICT", async () => {
    const args = { p_client_request_id: randomUUID(), p_material_id: m, p_location_id: b, p_target_quantity: 8, p_expected_current: 5, p_reason_code: "ZNALEZIONE" };
    const results = await Promise.all([asAdmin, asAdminB, asAdmin, asAdminB, asAdmin].map((c) => c.rpc("stock_adjust", args)));
    for (const r of results) expect(r.error).toBeNull();
    expect(results.filter((r) => !r.data.idempotent_replay)).toHaveLength(1);
    expect(new Set(results.map((r) => r.data.operation_id)).size).toBe(1);
    expect(await stockQty(m, b)).toBe(8);
    // Powtórzenie po czasie (stan już 8): replay, nie STOCK_CHANGED ani druga korekta.
    const replay = await asAdmin.rpc("stock_adjust", args);
    expect(replay.data).toMatchObject({ idempotent_replay: true, quantity_delta: 3, new_quantity: 8 });
    for (const changed of [{ p_target_quantity: 9 }, { p_reason_code: "INNY", p_reason: "x" }, { p_note: "inna" }, { p_location_id: a }]) {
      const r = await asAdmin.rpc("stock_adjust", { ...args, ...changed });
      expect(r.error?.hint, JSON.stringify(changed)).toBe("IDEMPOTENCY_CONFLICT");
    }
    // Ten sam id użyty dla wydania → konflikt.
    const asIssue = await asAdmin.rpc("stock_issue", {
      p_client_request_id: args.p_client_request_id,
      p_location_id: b,
      p_material_id: m,
      p_quantity: 1,
      p_reason_code: "SERWIS",
    });
    expect(asIssue.error?.hint).toBe("IDEMPOTENCY_CONFLICT");
    await expectConsistent();
  });
});

// ---------------------------------------------------------------------------
describe("korekta vs wydanie — współbieżność", () => {
  it("wydanie w toku → korekta czeka, potem STOCK_CHANGED (nie nadpisuje wydania)", async () => {
    const m = await material("RACE1");
    const a = await location("R1A");
    await receive(m, a, 10);
    const { waited, second } = await holdThenRun(
      async (tx) => {
        await actAs(tx, tProd.id);
        await tx`select public.stock_issue(${randomUUID()}::uuid, ${a}::uuid, ${m}::uuid, 3::numeric, null, 'SERWIS')`;
      },
      async (tx) => {
        await actAs(tx, tAdmin.id);
        await tx`select public.stock_adjust(${randomUUID()}::uuid, ${m}::uuid, ${a}::uuid, 8::numeric, 10::numeric, 'ZAGINIECIE')`;
      },
    );
    expect(waited).toBe(true);
    expect(second.hint).toBe("STOCK_CHANGED");
    expect(Number(second.detail)).toBe(7);
    expect(await stockQty(m, a)).toBe(7);
    expect(await opCount(m, "ADJUSTMENT")).toBe(0);
    await expectConsistent();
  });

  it("korekta w toku → wydanie czeka i widzi nowy stan (INSUFFICIENT_STOCK z nowym stanem)", async () => {
    const m = await material("RACE2");
    const a = await location("R2A");
    await receive(m, a, 10);
    const { waited, second } = await holdThenRun(
      async (tx) => {
        await actAs(tx, tAdmin.id);
        await tx`select public.stock_adjust(${randomUUID()}::uuid, ${m}::uuid, ${a}::uuid, 2::numeric, 10::numeric, 'ZAGINIECIE')`;
      },
      async (tx) => {
        await actAs(tx, tProd.id);
        await tx`select public.stock_issue(${randomUUID()}::uuid, ${a}::uuid, ${m}::uuid, 5::numeric, null, 'SERWIS')`;
      },
    );
    expect(waited).toBe(true);
    expect(second.hint).toBe("INSUFFICIENT_STOCK");
    expect(Number(second.detail)).toBe(2);
    expect(await stockQty(m, a)).toBe(2);
    await expectConsistent();
  });

  it("10 rund: korekta i 3 wydania równolegle → nigdy < 0, żaden ruch nie zginął, verify_stock = 0", async () => {
    const m = await material("RACE3");
    const a = await location("R3A");
    let receipts = 0;
    for (let round = 0; round < 10; round++) {
      const before = await stockQty(m, a);
      if (before < 10) {
        await receive(m, a, 10 - before);
        receipts++;
      }
      const results = await Promise.all([
        adjust(asAdmin, { p_material_id: m, p_location_id: a, p_target_quantity: 4, p_expected_current: 10 }),
        asProd.rpc("stock_issue", { p_client_request_id: randomUUID(), p_location_id: a, p_material_id: m, p_quantity: 3, p_reason_code: "SERWIS" }),
        asProd2.rpc("stock_issue", { p_client_request_id: randomUUID(), p_location_id: a, p_material_id: m, p_quantity: 3, p_reason_code: "SERWIS" }),
        asAdminB.rpc("stock_issue", { p_client_request_id: randomUUID(), p_location_id: a, p_material_id: m, p_quantity: 3, p_reason_code: "SERWIS" }),
      ]);
      const [adj, ...issues] = results;
      expect(adj.error === null || adj.error.hint === "STOCK_CHANGED").toBe(true);
      for (const r of issues) expect(r.error === null || r.error.hint === "INSUFFICIENT_STOCK", JSON.stringify(r.error)).toBe(true);
      const okIssues = issues.filter((r) => !r.error).length;
      const after = await stockQty(m, a);
      expect(after).toBeGreaterThanOrEqual(0);
      if (adj.error) {
        // Korekta odrzucona (stan zmienił się przed nią) — liczą się tylko wydania.
        expect(after).toBe(10 - 3 * okIssues);
      } else {
        // Korekta przeszła przy stanie 10 (przed wydaniami) → potem co najwyżej jedno wydanie z 4.
        expect(after).toBe(4 - 3 * okIssues);
      }
    }
    expect(receipts).toBeGreaterThan(0);
    await expectConsistent();
  });
});

// ---------------------------------------------------------------------------
describe("stock_reverse — storno", () => {
  it("cofnięcie przyjęcia: operacja REVERSAL z ruchem odwrotnym; oryginał bez zmian; stan wraca", async () => {
    const m = await material("REVR");
    const a = await location("REVR-A");
    const opId = await receive(m, a, 10, asProd);
    const originalBefore = await admin.from("stock_operations").select("*").eq("id", opId).single();
    const crid = randomUUID();
    const r = await asAdmin.rpc("stock_reverse", { p_client_request_id: crid, p_operation_id: opId, p_reason: "  zły materiał ", p_note: "x" });
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ reversed_operation_id: opId, idempotent_replay: false });
    expect(r.data.movements).toHaveLength(1);
    expect(Number(r.data.movements[0].quantity_delta)).toBe(-10);
    expect(Number(r.data.movements[0].new_quantity)).toBe(0);
    const rev = await admin.from("stock_operations").select("*").eq("client_request_id", crid).single();
    expect(rev.data).toMatchObject({ type: "REVERSAL", user_id: tAdmin.id, reverses_operation_id: opId, reason: "zły materiał", note: "x", reason_code: null });
    const originalAfter = await admin.from("stock_operations").select("*").eq("id", opId).single();
    expect(originalAfter.data).toEqual(originalBefore.data);
    expect(await stockQty(m, a)).toBe(0);
    await expectConsistent();

    // Drugi raz → ALREADY_REVERSED; cofnięcie cofnięcia → NOT_REVERSIBLE.
    expect((await reverse(asAdmin, opId)).error?.hint).toBe("ALREADY_REVERSED");
    expect((await reverse(asAdmin, rev.data!.id)).error?.hint).toBe("NOT_REVERSIBLE");
    // Operacje są niemutowalne także po stornie (UPDATE kolumny powiązania zablokowany).
    const upd = await sql`update public.stock_operations set reverses_operation_id = null where id = ${rev.data!.id}`.catch((e) => e);
    expect(upd.hint).toBe("IMMUTABLE");
  });

  it("cofnięcie wydania na zlecenie: zlecenie skopiowane, order_issue_summary pomniejszone", async () => {
    const m = await material("REVI");
    const a = await location("REVI-A");
    await receive(m, a, 10);
    const i1 = await asProd.rpc("stock_issue", { p_client_request_id: randomUUID(), p_location_id: a, p_material_id: m, p_quantity: 4, p_production_order_id: ids.order });
    const i2 = await asProd.rpc("stock_issue", { p_client_request_id: randomUUID(), p_location_id: a, p_material_id: m, p_quantity: 1, p_production_order_id: ids.order });
    expect(i1.error ?? i2.error).toBeNull();
    let summary = await getOrderIssueSummary(asBiuro, ids.order);
    expect(summary.ok && summary.data.find((s) => s.materialId === m)).toMatchObject({ quantity: 5, issues: 2, reversals: 0 });

    const r = await reverse(asAdmin, i1.data.operation_id, "wydano za dużo");
    expect(r.error).toBeNull();
    const rev = await admin.from("stock_operations").select("production_order_id").eq("id", r.data.operation_id).single();
    expect(rev.data?.production_order_id).toBe(ids.order);
    expect(await stockQty(m, a)).toBe(9);
    summary = await getOrderIssueSummary(asBiuro, ids.order);
    expect(summary.ok && summary.data.find((s) => s.materialId === m)).toMatchObject({ quantity: 1, issues: 2, reversals: 1 });
    await expectConsistent();
  });

  it("cofnięcie przesunięcia: 2 ruchy odwrotne; cofnięcie korekty", async () => {
    const m = await material("REVT");
    const a = await location("REVT-A");
    const b = await location("REVT-B");
    await receive(m, a, 10);
    const t = await asProd.rpc("stock_transfer", { p_client_request_id: randomUUID(), p_material_id: m, p_from_location_id: a, p_to_location_id: b, p_quantity: 6 });
    expect(t.error).toBeNull();
    const r = await reverse(asAdmin, t.data.operation_id, "nie ta półka");
    expect(r.error).toBeNull();
    const deltas = (r.data.movements as { location_id: string; quantity_delta: number }[]).map((x) => [x.location_id, Number(x.quantity_delta)]);
    expect(deltas.sort()).toEqual([[a, 6], [b, -6]].sort());
    expect(await stockQty(m, a)).toBe(10);
    expect(await stockQty(m, b)).toBe(0);

    const adj = await adjust(asAdmin, { p_material_id: m, p_location_id: a, p_target_quantity: 7, p_expected_current: 10 });
    expect(adj.error).toBeNull();
    expect((await reverse(asAdmin, adj.data.operation_id, "pomyłka w korekcie")).error).toBeNull();
    expect(await stockQty(m, a)).toBe(10);
    await expectConsistent();
  });

  it("brak stanu: przyjęcie 10, wydanie 8 → cofnięcie przyjęcia niemożliwe (lokalizacja i dostępna ilość)", async () => {
    const m = await material("REVX");
    const a = await location("REVX-A");
    const opId = await receive(m, a, 10);
    expect((await asProd.rpc("stock_issue", { p_client_request_id: randomUUID(), p_location_id: a, p_material_id: m, p_quantity: 8, p_reason_code: "SERWIS" })).error).toBeNull();
    const r = await reverse(asAdmin, opId);
    expect(r.error?.hint).toBe("INSUFFICIENT_STOCK");
    expect(JSON.parse(r.error!.details)).toEqual({ available: 2, location_code: `${P}-REVX-A` });
    const s = await createReversal(asAdmin, { client_request_id: randomUUID(), operation_id: opId, reason: "test" });
    expect(s.ok ? null : s.error).toMatchObject({ status: 409, code: "INSUFFICIENT_STOCK", details: { available: 2, locationCode: `${P}-REVX-A` } });
    expect(await stockQty(m, a)).toBe(2);
    expect(await opCount(m, "REVERSAL")).toBe(0);
  });

  it("cofnięcie zwiększające stan NIEAKTYWNEJ lokalizacji → LOCATION_INACTIVE (z kodem)", async () => {
    const m = await material("REVOFF");
    const a = await location("ROA");
    const b = await location("ROB");
    await receive(m, a, 3);
    const t = await asProd.rpc("stock_transfer", { p_client_request_id: randomUUID(), p_material_id: m, p_from_location_id: a, p_to_location_id: b, p_quantity: 3 });
    expect(t.error).toBeNull();
    expect((await asAdmin.from("locations").update({ active: false }).eq("id", a)).error).toBeNull();
    const r = await reverse(asAdmin, t.data.operation_id);
    expect(r.error?.hint).toBe("LOCATION_INACTIVE");
    expect(r.error?.details).toBe(`${P}-ROA`);
    expect(await stockQty(m, b)).toBe(3);
  });

  it("walidacja i role: powód < 3 znaków, nieznana operacja, BIURO/PRODUKCJA → 42501", async () => {
    const m = await material("REVV");
    const a = await location("REVV-A");
    const opId = await receive(m, a, 2);
    expect((await reverse(asAdmin, opId, " ab ")).error?.hint).toBe("REASON_REQUIRED");
    expect((await reverse(asAdmin, randomUUID())).error).toMatchObject({ hint: "NOT_FOUND", details: "operation" });
    for (const c of [asBiuro, asProd]) expect((await reverse(c, opId)).error?.code).toBe("42501");
    expect(await stockQty(m, a)).toBe(2);
  });

  it("5× równolegle (różne id, dwie sesje ADMIN) → dokładnie 1 sukces, 4× ALREADY_REVERSED", async () => {
    const m = await material("REVP");
    const a = await location("REVP-A");
    const opId = await receive(m, a, 5);
    await receive(m, a, 5);
    const results = await Promise.all([asAdmin, asAdminB, asAdmin, asAdminB, asAdmin].map((c) => reverse(c, opId)));
    expect(results.filter((r) => !r.error)).toHaveLength(1);
    expect(results.filter((r) => r.error?.hint === "ALREADY_REVERSED")).toHaveLength(4);
    expect(await stockQty(m, a)).toBe(5);
    expect(await opCount(m, "REVERSAL")).toBe(1);
    await expectConsistent();
  });

  it("idempotencja storna: ten sam id 5× → 1 storno (replay); inny powód z tym id → IDEMPOTENCY_CONFLICT", async () => {
    const m = await material("REVID");
    const a = await location("RIDA");
    const opId = await receive(m, a, 4);
    const crid = randomUUID();
    const results = await Promise.all([asAdmin, asAdminB, asAdmin, asAdminB, asAdmin].map((c) => reverse(c, opId, "pomyłka", crid)));
    for (const r of results) expect(r.error).toBeNull();
    expect(results.filter((r) => !r.data.idempotent_replay)).toHaveLength(1);
    expect(new Set(results.map((r) => r.data.operation_id)).size).toBe(1);
    expect((await reverse(asAdmin, opId, "inny powód", crid)).error?.hint).toBe("IDEMPOTENCY_CONFLICT");
    expect(await stockQty(m, a)).toBe(0);
    await expectConsistent();
  });
});

// ---------------------------------------------------------------------------
describe("historia ruchów (list_stock_movements)", () => {
  let m: string;
  let a: string;
  let b: string;
  let receiptId: string;
  let transferId: string;
  let reversalId: string;
  beforeAll(async () => {
    m = await material("HIST");
    a = await location("HIST-A");
    b = await location("HIST-B");
    receiptId = await receive(m, a, 20, asProd);
    const t = await asProd2.rpc("stock_transfer", { p_client_request_id: randomUUID(), p_material_id: m, p_from_location_id: a, p_to_location_id: b, p_quantity: 5 });
    transferId = t.data.operation_id;
    await asProd.rpc("stock_issue", { p_client_request_id: randomUUID(), p_location_id: a, p_material_id: m, p_quantity: 2, p_production_order_id: ids.order });
    await adjust(asAdmin, { p_material_id: m, p_location_id: a, p_target_quantity: 12, p_expected_current: 13 });
    const r = await reverse(asAdmin, transferId, "zła lokalizacja");
    reversalId = r.data.operation_id;
  });

  it("wszystkie typy, przesunięcie i jego storno jako jeden wiersz „skąd → dokąd”, oznaczenia cofnięcia", async () => {
    const h = await listMovements(asBiuro, { materialId: m, page: 1, pageSize: 50 }, { collapseTransfers: true });
    expect(h.ok).toBe(true);
    if (!h.ok) return;
    expect(h.data.total).toBe(5);
    expect(new Set(h.data.items.map((i) => i.type))).toEqual(new Set(["RECEIPT", "TRANSFER", "ISSUE", "ADJUSTMENT", "REVERSAL"]));
    const tr = h.data.items.find((i) => i.type === "TRANSFER")!;
    expect(tr).toMatchObject({ fromLocationCode: `${P}-HIST-A`, toLocationCode: `${P}-HIST-B`, reversible: false, reversedByOperationId: reversalId, reversedReason: "zła lokalizacja", reversedByUserName: "Test ADMIN" });
    const rv = h.data.items.find((i) => i.type === "REVERSAL")!;
    expect(rv).toMatchObject({ reversesOperationId: transferId, reversesType: "TRANSFER", fromLocationCode: `${P}-HIST-B`, toLocationCode: `${P}-HIST-A`, reversible: false });
    expect(h.data.items.find((i) => i.type === "RECEIPT")).toMatchObject({ reversible: true, reversedAt: null });
    expect(h.data.items.find((i) => i.type === "ADJUSTMENT")).toMatchObject({ reasonCode: "ZAGINIECIE", quantityDelta: -1 });
  });

  it("filtry: typ, lokalizacja (obie strony przesunięcia), użytkownik, operacja (+ storno), zlecenie, daty", async () => {
    const q = (extra: Record<string, unknown>) =>
      listMovements(asAdmin, { materialId: m, page: 1, pageSize: 50, ...extra }, { collapseTransfers: true });
    const total = async (extra: Record<string, unknown>) => {
      const r = await q(extra);
      if (!r.ok) throw new Error(r.error.code);
      return r.data.total;
    };
    expect(await total({ type: "REVERSAL" })).toBe(1);
    expect(await total({ type: "ADJUSTMENT" })).toBe(1);
    // B: tylko przesunięcie i jego storno (zwinięte); A: przyjęcie, przesunięcie, wydanie, korekta, storno.
    expect(await total({ locationId: b })).toBe(2);
    expect(await total({ locationId: a })).toBe(5);
    expect(await total({ userId: tProd2.id })).toBe(1);
    expect(await total({ userId: tAdmin.id })).toBe(2);
    expect(await total({ operationId: transferId })).toBe(2);
    expect(await total({ operationId: receiptId })).toBe(1);
    expect(await total({ orderId: ids.order })).toBe(1);
    expect(await total({ from: warsawToday(), to: warsawToday() })).toBe(5);
    expect(await total({ to: "2020-01-01" })).toBe(0);
    // Bez zwijania: przesunięcie i storno mają po 2 ruchy.
    const full = await listMovements(asAdmin, { materialId: m, page: 1, pageSize: 50 });
    expect(full.ok && full.data.total).toBe(7);
  });

  it("paginacja: strony rozłączne, total stały", async () => {
    const p1 = await listMovements(asAdmin, { materialId: m, page: 1, pageSize: 2 }, { collapseTransfers: true });
    const p3 = await listMovements(asAdmin, { materialId: m, page: 3, pageSize: 2 }, { collapseTransfers: true });
    const p4 = await listMovements(asAdmin, { materialId: m, page: 4, pageSize: 2 }, { collapseTransfers: true });
    expect(p1.ok && p3.ok && p4.ok).toBe(true);
    if (!p1.ok || !p3.ok || !p4.ok) return;
    expect([p1.data.total, p3.data.total, p4.data.total]).toEqual([5, 5, 5]);
    expect(p1.data.items).toHaveLength(2);
    expect(p3.data.items).toHaveLength(1);
    expect(p4.data.items).toHaveLength(0);
    expect(p1.data.items.map((i) => i.movementId)).not.toContain(p3.data.items[0].movementId);
  });

  it("PRODUKCJA widzi tylko własne ruchy (także z filtrem użytkownika innej osoby)", async () => {
    const own = await listMovements(asProd, { materialId: m, page: 1, pageSize: 50 }, { collapseTransfers: true });
    expect(own.ok && own.data.items.every((i) => i.userName === "Test PRODUKCJA")).toBe(true);
    expect(own.ok && own.data.total).toBe(2); // przyjęcie + wydanie
    // Własne przyjęcie — PRODUKCJA widzi, czy zostało cofnięte (tu: nie).
    const other = await listMovements(asProd, { materialId: m, userId: tAdmin.id, page: 1, pageSize: 50 });
    expect(other.ok && other.data.total).toBe(0);
  });

  it("list_user_names: ADMIN/BIURO tak, PRODUKCJA 42501; verify (serwis): ADMIN OK, BIURO 403", async () => {
    const names = await listUserNames(asBiuro);
    expect(names.ok && names.data.some((u) => u.id === tProd.id && u.fullName === "Test PRODUKCJA")).toBe(true);
    const prod = await asProd.rpc("list_user_names");
    expect(prod.error?.code).toBe("42501");
    const v = await verifyStock(asAdmin);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.data.discrepancies.filter((d) => testMaterials.includes(d.materialId))).toEqual([]);
    const vb = await verifyStock(asBiuro);
    expect(vb.ok ? null : vb.error.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
describe("poprawki po review Etapu 6", () => {
  it("L1: ten sam id z (5, 0), potem (105, 100) — ta sama różnica, inny stan widziany → IDEMPOTENCY_CONFLICT", async () => {
    const m = await material("L1");
    const a = await location("L1A");
    const crid = randomUUID();
    const args = { p_client_request_id: crid, p_material_id: m, p_location_id: a, p_reason_code: "STAN_POCZATKOWY" };
    expect((await adjust(asAdmin, { ...args, p_target_quantity: 5, p_expected_current: 0 })).error).toBeNull();
    const op = await admin.from("stock_operations").select("adjust_expected").eq("client_request_id", crid).single();
    expect(Number(op.data?.adjust_expected)).toBe(0);
    const replay = await adjust(asAdmin, { ...args, p_target_quantity: 5, p_expected_current: 0 });
    expect(replay.data).toMatchObject({ idempotent_replay: true, previous_quantity: 0 });
    const other = await adjust(asAdmin, { ...args, p_target_quantity: 105, p_expected_current: 100 });
    expect(other.error?.hint).toBe("IDEMPOTENCY_CONFLICT");
    expect(await stockQty(m, a)).toBe(5);
  });

  it("storno przesunięcia vs równoległe wydanie z B (obie kolejności) → nigdy < 0, przegrany dostaje INSUFFICIENT_STOCK", async () => {
    for (const reversalFirst of [false, true]) {
      const tag = reversalFirst ? "RVB2" : "RVB1";
      const m = await material(tag);
      const a = await location(`${tag}A`);
      const b = await location(`${tag}B`);
      await receive(m, a, 5);
      const t = await asProd.rpc("stock_transfer", { p_client_request_id: randomUUID(), p_material_id: m, p_from_location_id: a, p_to_location_id: b, p_quantity: 5 });
      expect(t.error).toBeNull();
      const issueSql = async (tx: postgres.TransactionSql) => {
        await actAs(tx, tProd.id);
        await tx`select public.stock_issue(${randomUUID()}::uuid, ${b}::uuid, ${m}::uuid, 3::numeric, null, 'SERWIS')`;
      };
      const reverseSql = async (tx: postgres.TransactionSql) => {
        await actAs(tx, tAdmin.id);
        await tx`select public.stock_reverse(${randomUUID()}::uuid, ${t.data.operation_id}::uuid, 'test równoległy')`;
      };
      const { waited, second } = reversalFirst ? await holdThenRun(reverseSql, issueSql) : await holdThenRun(issueSql, reverseSql);
      expect(waited).toBe(true);
      expect(second.hint).toBe("INSUFFICIENT_STOCK");
      if (reversalFirst) {
        expect(await stockQty(m, a)).toBe(5);
        expect(await stockQty(m, b)).toBe(0);
      } else {
        expect(JSON.parse(second.detail!)).toMatchObject({ available: 2 });
        expect(await stockQty(m, a)).toBe(0);
        expect(await stockQty(m, b)).toBe(2);
      }
    }
    await expectConsistent();
  });

  it("storno zwiększające stan NIEAKTYWNEGO materiału → MATERIAL_INACTIVE", async () => {
    const m = await material("RMI");
    const a = await location("RMIA");
    await receive(m, a, 2);
    const iss = await asProd.rpc("stock_issue", { p_client_request_id: randomUUID(), p_location_id: a, p_material_id: m, p_quantity: 2, p_reason_code: "SERWIS" });
    expect(iss.error).toBeNull();
    expect((await asAdmin.from("materials").update({ active: false }).eq("id", m)).error).toBeNull();
    const r = await reverse(asAdmin, iss.data.operation_id);
    expect(r.error?.hint).toBe("MATERIAL_INACTIVE");
    expect(await stockQty(m, a)).toBe(0);
  });

  it("storno wydania bez zlecenia (z kodem powodu): REVERSAL bez zlecenia i kodu; PRODUKCJA widzi „cofnięto” tylko dla własnej", async () => {
    const m = await material("RNO");
    const a = await location("RNOA");
    await receive(m, a, 4);
    const iss = await asProd.rpc("stock_issue", { p_client_request_id: randomUUID(), p_location_id: a, p_material_id: m, p_quantity: 3, p_reason_code: "INNY", p_reason: "pokaz" });
    expect(iss.error).toBeNull();
    const r = await reverse(asAdmin, iss.data.operation_id, "pomyłka");
    expect(r.error).toBeNull();
    const op = await admin.from("stock_operations").select("type, production_order_id, reason_code, reason").eq("id", r.data.operation_id).single();
    expect(op.data).toEqual({ type: "REVERSAL", production_order_id: null, reason_code: null, reason: "pomyłka" });
    expect(await stockQty(m, a)).toBe(4);
    const own = await asProd.rpc("reversed_operation_ids", { p_ids: [iss.data.operation_id] });
    expect(own.data).toEqual([iss.data.operation_id]);
    const foreign = await asProd2.rpc("reversed_operation_ids", { p_ids: [iss.data.operation_id] });
    expect(foreign.data).toEqual([]);
    await expectConsistent();
  });

  it("PRODUKCJA z p_operation_id cudzej operacji → 0 wierszy", async () => {
    const m = await material("FOR");
    const a = await location("FORA");
    const opId = await receive(m, a, 1, asProd);
    const own = await listMovements(asProd, { operationId: opId, page: 1, pageSize: 10 });
    expect(own.ok && own.data.total).toBe(1);
    const foreign = await listMovements(asProd2, { operationId: opId, page: 1, pageSize: 10 });
    expect(foreign.ok && foreign.data.total).toBe(0);
  });

  it("fraza materiału z % i _ traktowana dosłownie", async () => {
    const m = await material("LIT1");
    const a = await location("LITA");
    await receive(m, a, 1);
    const total = async (q: string) => {
      const r = await listMovements(asBiuro, { q, page: 1, pageSize: 10 });
      if (!r.ok) throw new Error(r.error.code);
      return r.data.total;
    };
    expect(await total(`${P}-LIT1`)).toBe(1);
    expect(await total(`${P}-LI%1`)).toBe(0);
    expect(await total(`${P}-LI_1`)).toBe(0);
    expect(await total(`${P}%LIT1`)).toBe(0);
  });

  it("granica dnia w Europe/Warsaw: 23:30 należy do tego dnia, 00:30 do następnego", async () => {
    const m = await material("TZ");
    const a = await location("TZA");
    // ::text przed ::timestamp — inaczej postgres.js przepuszcza tekst przez Date w strefie procesu.
    // Ruchy z ustaloną godziną — wyłącznie materiał testowy, w transakcji z flagą zapisu funkcji stockowych; stan
    // zgodny z ruchami (verify_stock). Sprzątane przez purge_test_stock.
    await sql.begin(async (tx) => {
      await tx`select set_config('forbud.stock_write', 'on', true)`;
      for (const at of ["2026-01-15 23:30", "2026-01-16 00:30"]) {
        const [op] = await tx`
          insert into public.stock_operations (type, user_id, client_request_id, created_at)
          values ('RECEIPT', ${tAdmin.id}, ${randomUUID()}, ((${at}::text)::timestamp at time zone 'Europe/Warsaw'))
          returning id, created_at`;
        await tx`
          insert into public.stock_movements (operation_id, material_id, location_id, quantity_delta, user_id, created_at)
          values (${op.id}, ${m}, ${a}, 1, ${tAdmin.id}, ${op.created_at})`;
      }
      await tx`insert into public.stock (material_id, location_id, quantity) values (${m}, ${a}, 2)`;
      await tx`select set_config('forbud.stock_write', '', true)`;
    });
    const total = async (from: string, to: string) => {
      const r = await listMovements(asBiuro, { materialId: m, from, to, page: 1, pageSize: 10 });
      if (!r.ok) throw new Error(r.error.code);
      return r.data.total;
    };
    expect(await total("2026-01-15", "2026-01-15")).toBe(1);
    expect(await total("2026-01-16", "2026-01-16")).toBe(1);
    expect(await total("2026-01-14", "2026-01-14")).toBe(0);
    expect(await total("2026-01-15", "2026-01-16")).toBe(2);
    await expectConsistent();
  });
});

// ---------------------------------------------------------------------------
describe("sprzątanie testów", () => {
  it("purge_test_stock usuwa storna i korekty (FK reverses_operation_id) razem z oryginałami", async () => {
    const m = await material("PURGE");
    const a = await location("PGA");
    const opId = await receive(m, a, 5);
    const adj = await adjust(asAdmin, { p_material_id: m, p_location_id: a, p_target_quantity: 3, p_expected_current: 5 });
    expect(adj.error).toBeNull();
    expect((await reverse(asAdmin, adj.data.operation_id)).error).toBeNull();
    // Po cofnięciu korekty stan znów 5 → cofnięcie przyjęcia możliwe (storno storna nie, ale storno oryginału tak).
    expect((await reverse(asAdmin, opId)).error).toBeNull();
    expect(await stockQty(m, a)).toBe(0);
    const opIds = (await admin.from("stock_movements").select("operation_id").eq("material_id", m)).data!.map((r) => r.operation_id);
    expect(new Set(opIds).size).toBe(4);
    const purge = await admin.rpc("purge_test_stock", { p_material_ids: [m] });
    expect(purge.error).toBeNull();
    expect(purge.data).toBe(4);
    const left = await admin.from("stock_operations").select("id").in("id", opIds);
    expect(left.data).toEqual([]);
    expect(await stockQty(m, a)).toBe(0);
  });

  it("końcowa spójność: verify_stock = 0", async () => {
    await expectConsistent();
  });
});
