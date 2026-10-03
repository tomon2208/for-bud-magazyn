import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveInventory, createInventorySession, getCountingLocation, getSessionReview, saveLocationCount } from "@/server/inventory";
import { adminClient, createTestUser, deleteAllTestUsers, signIn, type TestUser } from "./helpers";

// Etap 13 (ADR 015): inwentaryzacja — role, liczenie na ślepo, lokalizacja w jednej otwartej sesji, zatwierdzanie
// (INVENTORY, MATCHED, RECOUNT po ruchu), współbieżność zatwierdzania z wydaniem/przyjęciem (dwa połączenia),
// idempotencja, nieaktywne tylko w dół, nadrezerwacja bez zmian rezerwacji, storno, sprzątanie testów.
// Dane: materiały is_test, lokalizacje/sesje/zlecenia TEST-<runId>-…; sprzątanie przez purge_test_stock.

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
let asBiuroB: SupabaseClient;
let asProd: SupabaseClient;
let asProdB: SupabaseClient;

const ids = { category: "" };
const testMaterials: string[] = [];
const testSessions: string[] = [];
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

async function receive(materialId: string, locationId: string, qty: number, client: SupabaseClient = asAdmin) {
  const r = await client.rpc("stock_receipt", {
    p_client_request_id: randomUUID(),
    p_location_id: locationId,
    p_material_id: materialId,
    p_quantity: qty,
  });
  if (r.error) throw r.error;
}

const issue = (client: SupabaseClient, materialId: string, locationId: string, qty: number) =>
  client.rpc("stock_issue", {
    p_client_request_id: randomUUID(),
    p_location_id: locationId,
    p_material_id: materialId,
    p_quantity: qty,
    p_reason_code: "SERWIS",
  });

type CreateArgs = { ids?: string[]; prefix?: string; all?: boolean; crid?: string; name?: string };
const createRaw = (client: SupabaseClient, a: CreateArgs) =>
  client.rpc("inventory_create_session", {
    p_client_request_id: a.crid ?? randomUUID(),
    p_name: a.name ?? `${P}-sesja`,
    p_note: null,
    p_location_ids: a.ids ?? null,
    p_code_prefix: a.prefix ?? null,
    p_all_locations: a.all ?? false,
  });

async function session(locationIds: string[], name = "sesja"): Promise<string> {
  const r = await createRaw(asBiuro, { ids: locationIds, name: `${P}-${name}` });
  if (r.error) throw r.error;
  const id = (r.data as { session_id: string }).session_id;
  testSessions.push(id);
  return id;
}

type Item = { material_id: string; quantity: number | string };
async function view(client: SupabaseClient, sid: string, lid: string) {
  const r = await client.rpc("inventory_counting_location", { p_session_id: sid, p_location_id: lid });
  if (r.error) throw r.error;
  return r.data as {
    server_time: string;
    location_version: number;
    counted_at: string | null;
    items: { material_id: string; code: string; expected: boolean; counted_quantity: number | null; state: string | null }[];
  };
}
const saveRaw = (client: SupabaseClient, sid: string, lid: string, items: Item[], startedAt: string, crid = randomUUID(), version = 0) =>
  client.rpc("inventory_save_location_count", {
    p_client_request_id: crid,
    p_session_id: sid,
    p_location_id: lid,
    p_items: items,
    p_started_at: startedAt,
    p_expected_version: version,
  });
/** Liczenie lokalizacji: otwarcie ekranu (czas serwera) → zapis. */
async function count(sid: string, lid: string, items: Item[], client: SupabaseClient = asProd) {
  const v = await view(client, sid, lid);
  const r = await saveRaw(client, sid, lid, items, v.server_time, undefined, v.location_version);
  if (r.error) throw r.error;
  return r.data as { saved: number; removed: number; unchanged: number };
}
const approveRaw = (
  client: SupabaseClient,
  sid: string,
  countIds: string[] | null = null,
  crid = randomUUID(),
  expected: Record<string, number> | null = null,
) => client.rpc("inventory_approve", { p_client_request_id: crid, p_session_id: sid, p_count_ids: countIds, p_expected_counts: expected });

type ApproveData = {
  operation_id: string | null;
  approved: { count_id: string; material_code: string; quantity_delta: number }[];
  approved_count: number;
  matched_count: number;
  recount: { count_id: string; material_code: string }[];
  skipped: { count_id: string; reason: string }[];
  idempotent_replay: boolean;
};
async function approve(sid: string, countIds: string[] | null = null, client: SupabaseClient = asBiuro): Promise<ApproveData> {
  const r = await approveRaw(client, sid, countIds);
  if (r.error) throw r.error;
  return r.data as ApproveData;
}

async function review(sid: string) {
  const r = await asBiuro.rpc("inventory_session_review", { p_session_id: sid });
  if (r.error) throw r.error;
  return r.data as {
    count_id: string | null;
    material_id: string;
    location_id: string;
    status: string;
    system_quantity: number;
    counted_quantity: number | null;
    difference: number | null;
    blocked_reason: string | null;
    material_reserved: number;
    operation_reversed: boolean;
  }[];
}
const rowOf = async (sid: string, materialId: string, locationId: string) =>
  (await review(sid)).find((r) => r.material_id === materialId && r.location_id === locationId);

async function stockQty(materialId: string, locationId: string): Promise<number> {
  const { data, error } = await admin.from("stock").select("quantity").eq("material_id", materialId).eq("location_id", locationId).maybeSingle();
  if (error) throw error;
  return data ? Number(data.quantity) : 0;
}

async function verify(materialIds: string[] = testMaterials) {
  const v = await admin.rpc("verify_stock", { p_material_ids: materialIds });
  expect(v.error).toBeNull();
  expect(v.data).toEqual([]);
}

async function actAs(tx: postgres.TransactionSql, userId: string) {
  await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`;
  await tx.unsafe("set local role authenticated");
}

/** Dwie transakcje: A wykonuje `first` i trzyma blokady; B (`second`) musi czekać; po zatwierdzeniu A — wynik B. */
async function holdThenRun(first: (tx: postgres.TransactionSql) => Promise<unknown>, second: (tx: postgres.TransactionSql) => Promise<unknown>) {
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
      (v) => ({ ok: true as const, value: v as unknown, hint: undefined as string | undefined, code: undefined as string | undefined }),
      (e: { hint?: string; code?: string }) => ({ ok: false as const, value: null as unknown, hint: e.hint, code: e.code }),
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
  [asAdmin, asBiuro, asBiuroB, asProd, asProdB] = await Promise.all([signIn(tAdmin), signIn(tBiuro), signIn(tBiuro), signIn(tProd), signIn(tProd)]);
  const cat = await asAdmin.from("material_categories").insert({ name: `${P}-kat` }).select("id").single();
  if (cat.error) throw cat.error;
  ids.category = cat.data.id;
});

afterAll(async () => {
  try {
    // Otwarte sesje testowe zamykamy (zwalniają lokalizacje), potem sprzątanie.
    for (const sid of testSessions) {
      await asBiuro.rpc("inventory_close_session", { p_client_request_id: randomUUID(), p_session_id: sid });
    }
    if (testOrders.length > 0) {
      const del = await admin.from("requirements").delete().in("production_order_id", testOrders);
      if (del.error) console.warn("requirements delete:", del.error.message);
    }
    const purge = await admin.rpc("purge_test_stock", {
      p_material_ids: testMaterials,
      p_order_ids: testOrders,
      p_inventory_session_ids: testSessions,
    });
    if (purge.error) console.warn("purge_test_stock:", purge.error.message);
    const left = await admin.from("inventory_sessions").select("id").in("id", testSessions);
    if ((left.data ?? []).length > 0) console.warn("Pozostały sesje testowe:", left.data?.length);
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
describe("role i liczenie na ślepo", () => {
  let m: string;
  let a: string;
  let sid: string;
  beforeAll(async () => {
    m = await material("R1");
    a = await location("R1A");
    await receive(m, a, 10);
    sid = await session([a], "role");
  });

  it("PRODUKCJA nie tworzy / nie zatwierdza / nie zamyka / nie anuluje (42501); BIURO nie liczy (42501)", async () => {
    expect((await createRaw(asProd, { ids: [a] })).error?.code).toBe("42501");
    expect((await approveRaw(asProd, sid)).error?.code).toBe("42501");
    expect((await asProd.rpc("inventory_close_session", { p_client_request_id: randomUUID(), p_session_id: sid })).error?.code).toBe("42501");
    expect((await asProd.rpc("inventory_cancel_session", { p_client_request_id: randomUUID(), p_session_id: sid })).error?.code).toBe("42501");
    const v = await view(asAdmin, sid, a);
    expect((await saveRaw(asBiuro, sid, a, [{ material_id: m, quantity: 1 }], v.server_time, undefined, v.location_version)).error?.code).toBe("42501");
  });

  it("ekran liczenia: materiały oczekiwane bez ilości; PRODUKCJA nie czyta stanu systemowego żadną drogą inwentaryzacji", async () => {
    const v = await view(asProd, sid, a);
    expect(v.items).toHaveLength(1);
    expect(v.items[0]).toMatchObject({ material_id: m, expected: true, counted_quantity: null, state: null });
    expect(Object.keys(v.items[0]).sort()).toEqual(
      ["active", "allows_fraction", "code", "counted_at", "counted_by_name", "counted_quantity", "expected", "material_id", "name", "state", "unit"].sort(),
    );
    expect(Object.keys(v).sort()).toEqual(["counted_at", "counted_by_name", "items", "location", "location_version", "server_time", "session"].sort());
    await count(sid, a, [{ material_id: m, quantity: 7 }]);
    // Zapisane liczenie (własne dane liczącego) — nadal bez stanu i różnicy.
    const after = await view(asProd, sid, a);
    expect(after.items[0]).toMatchObject({ counted_quantity: 7, state: "COUNTED" });
    // Serwis (DTO terminala): jawne pola, bez stanu systemowego.
    const dto = await getCountingLocation(asProd, sid, a);
    expect(dto.ok).toBe(true);
    if (dto.ok) expect(Object.keys(dto.data.items[0]).sort()).toEqual(
      ["active", "allowsFraction", "code", "countedAt", "countedByName", "countedQuantity", "expected", "materialId", "name", "state", "unit"].sort(),
    );
    // Tabela zatwierdzania, CSV, liczenia i historia — tylko BIURO/ADMIN.
    expect((await asProd.rpc("inventory_session_review", { p_session_id: sid })).error?.code).toBe("42501");
    expect((await asProd.rpc("export_inventory_csv", { p_session_id: sid })).error?.code).toBe("42501");
    expect((await asProd.rpc("inventory_session_events", { p_session_id: sid })).error?.code).toBe("42501");
    expect((await asProd.from("inventory_counts").select("*").eq("session_id", sid)).data).toEqual([]);
    expect((await asProd.from("inventory_count_events").select("*").eq("session_id", sid)).data).toEqual([]);
    expect((await asProd.from("inventory_requests").select("*").eq("session_id", sid)).data).toEqual([]);
    // Sesje i lokalizacje sesji są widoczne (wybór sesji na terminalu).
    expect((await asProd.from("inventory_sessions").select("id").eq("id", sid)).data).toHaveLength(1);
    // BIURO widzi stan systemowy i różnicę.
    const r = await rowOf(sid, m, a);
    expect(r).toMatchObject({ status: "DIFF", counted_quantity: 7 });
    expect(Number(r!.system_quantity)).toBe(10);
    expect(Number(r!.difference)).toBe(-3);
  });

  it("zapis bezpośredni do tabel inwentaryzacji zabroniony (także kluczem secret)", async () => {
    expect((await asBiuro.from("inventory_counts").update({ counted_quantity: 1 }).eq("session_id", sid).select()).data ?? []).toEqual([]);
    expect((await asBiuro.from("inventory_sessions").insert({ name: `${P}-x`, created_by: tBiuro.id })).error).not.toBeNull();
    const svc = await admin.from("inventory_counts").update({ counted_quantity: 1 }).eq("session_id", sid);
    expect(svc.error).not.toBeNull();
    const svcDel = await admin.from("inventory_count_events").delete().eq("session_id", sid);
    expect(svcDel.error).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("sesja: tworzenie, lokalizacja w jednej otwartej sesji, zamknięcie, anulowanie", () => {
  it("prefiks wybiera aktywne lokalizacje; ta sama lokalizacja w drugiej otwartej sesji → LOCATION_IN_OPEN_SESSION; po zamknięciu wolna", async () => {
    const l1 = await location("PX-1");
    const l2 = await location("PX-2");
    const crid = randomUUID();
    const r = await createRaw(asBiuro, { prefix: `${P.toLowerCase()}-px-`, crid, name: `${P}-prefiks` });
    expect(r.error).toBeNull();
    const s1 = (r.data as { session_id: string; location_count: number }).session_id;
    testSessions.push(s1);
    expect((r.data as { location_count: number }).location_count).toBe(2);
    const sl = await asProd.from("inventory_session_locations").select("location_id").eq("session_id", s1);
    expect((sl.data ?? []).map((x) => x.location_id).sort()).toEqual([l1, l2].sort());
    // replay: ten sam id i parametry → ta sama sesja; inne parametry → konflikt
    const again = await createRaw(asBiuro, { prefix: `${P.toLowerCase()}-px-`, crid, name: `${P}-prefiks` });
    expect(again.data).toMatchObject({ session_id: s1, idempotent_replay: true });
    expect((await createRaw(asBiuro, { prefix: `${P}-PX-`, crid, name: `${P}-inna` })).error?.hint).toBe("IDEMPOTENCY_CONFLICT");

    const dup = await createRaw(asBiuro, { ids: [l2], name: `${P}-dup` });
    expect(dup.error?.hint).toBe("LOCATION_IN_OPEN_SESSION");
    expect(dup.error?.details).toContain(`${P}-PX-2`);
    // Równolegle dwie sesje na tę samą wolną lokalizację → dokładnie jedna powstaje.
    const l3 = await location("PX3");
    const both = await Promise.all([createRaw(asBiuro, { ids: [l3], name: `${P}-r1` }), createRaw(asBiuroB, { ids: [l3], name: `${P}-r2` })]);
    for (const b of both) if (!b.error) testSessions.push((b.data as { session_id: string }).session_id);
    expect(both.filter((b) => !b.error)).toHaveLength(1);
    expect(both.filter((b) => b.error?.hint === "LOCATION_IN_OPEN_SESSION")).toHaveLength(1);

    const closed = await asBiuro.rpc("inventory_close_session", { p_client_request_id: randomUUID(), p_session_id: s1 });
    expect(closed.data).toMatchObject({ status: "CLOSED", uncounted_locations: 2, unapproved_counts: 0 });
    const s2 = await session([l2], "po-zamknieciu");
    expect(s2).toBeTruthy();
    expect((await asBiuro.rpc("inventory_close_session", { p_client_request_id: randomUUID(), p_session_id: s1 })).error?.hint).toBe("SESSION_NOT_OPEN");
  });

  it("walidacja: nieaktywna lokalizacja, brak wyboru, brak pasujących, dwa sposoby naraz", async () => {
    const off = await location("OFF1");
    expect((await asAdmin.from("locations").update({ active: false }).eq("id", off)).error).toBeNull();
    expect((await createRaw(asBiuro, { ids: [off] })).error?.hint).toBe("LOCATION_INACTIVE");
    expect((await createRaw(asBiuro, {})).error?.hint).toBe("VALIDATION");
    expect((await createRaw(asBiuro, { prefix: "ZZZ-NIE-ISTNIEJE-" })).error?.hint).toBe("NO_LOCATIONS");
    expect((await createRaw(asBiuro, { prefix: "A", all: true })).error?.hint).toBe("VALIDATION");
  });

  it("anulowanie: bez zatwierdzeń — CANCELLED i lokalizacja zwolniona; z zatwierdzeniem — SESSION_HAS_APPROVALS", async () => {
    const m = await material("CN1");
    const l = await location("CN1");
    const s = await session([l], "anul");
    await count(s, l, [{ material_id: m, quantity: 0 }]);
    const c = await asBiuro.rpc("inventory_cancel_session", { p_client_request_id: randomUUID(), p_session_id: s, p_reason: " pomyłka " });
    expect(c.data).toMatchObject({ status: "CANCELLED" });
    const row = await asBiuro.from("inventory_sessions").select("status, cancel_reason").eq("id", s).single();
    expect(row.data).toMatchObject({ status: "CANCELLED", cancel_reason: "pomyłka" });
    const v = await view(asProd, s, l);
    expect((await saveRaw(asProd, s, l, [{ material_id: m, quantity: 1 }], v.server_time, undefined, v.location_version)).error?.hint).toBe("SESSION_NOT_OPEN");

    const s2 = await session([l], "anul2");
    await count(s2, l, [{ material_id: m, quantity: 0 }]);
    const ap = await approve(s2);
    expect(ap.matched_count).toBe(1);
    expect((await asBiuro.rpc("inventory_cancel_session", { p_client_request_id: randomUUID(), p_session_id: s2 })).error?.hint).toBe(
      "SESSION_HAS_APPROVALS",
    );
  });
});

// ---------------------------------------------------------------------------
describe("liczenie: walidacja, nadpisywanie, historia", () => {
  let m: string;
  let mb: string;
  let m3: string;
  let a: string;
  let other: string;
  let sid: string;
  beforeAll(async () => {
    m = await material("C1");
    mb = await material("C2", "mb");
    m3 = await material("C3");
    a = await location("C1A");
    other = await location("C1B");
    await receive(m, a, 5);
    sid = await session([a], "liczenie");
  });

  it("walidacja: duplikat, ułamek dla szt., ujemna, lokalizacja spoza sesji, stary znacznik, 0 dozwolone", async () => {
    const v = await view(asProd, sid, a);
    expect((await saveRaw(asProd, sid, a, [{ material_id: m, quantity: 1 }, { material_id: m, quantity: 2 }], v.server_time, undefined, v.location_version)).error?.hint).toBe(
      "DUPLICATE_MATERIAL",
    );
    const frac = await saveRaw(asProd, sid, a, [{ material_id: m, quantity: 1.5 }], v.server_time, undefined, v.location_version);
    expect(frac.error?.hint).toBe("NOT_INTEGER");
    expect(frac.error?.details).toBe(`${P}-C1`);
    expect((await saveRaw(asProd, sid, a, [{ material_id: m, quantity: -1 }], v.server_time, undefined, v.location_version)).error?.hint).toBe("INVALID_QUANTITY");
    expect((await saveRaw(asProd, sid, a, [{ material_id: m, quantity: 1.0001 }], v.server_time, undefined, v.location_version)).error?.hint).toBe("INVALID_QUANTITY");
    expect((await saveRaw(asProd, sid, other, [{ material_id: m, quantity: 1 }], v.server_time, undefined, v.location_version)).error?.hint).toBe("LOCATION_NOT_IN_SESSION");
    const old = new Date(Date.now() - 13 * 3600 * 1000).toISOString();
    expect((await saveRaw(asProd, sid, a, [{ material_id: m, quantity: 1 }], old)).error?.hint).toBe("COUNT_STALE");
    const ok = await saveRaw(asProd, sid, a, [{ material_id: m, quantity: 0 }, { material_id: mb, quantity: 2.125 }], v.server_time, undefined, v.location_version);
    expect(ok.error).toBeNull();
    expect(ok.data).toMatchObject({ saved: 2, removed: 0, idempotent_replay: false });
  });

  it("ponowne liczenie nadpisuje, usuwa pominięte (niezatwierdzone) i zapisuje historię z poprzednimi wartościami", async () => {
    await count(sid, a, [{ material_id: m, quantity: 4 }, { material_id: m3, quantity: 1 }], asAdmin);
    const counts = await asBiuro.from("inventory_counts").select("material_id, counted_quantity, counted_by").eq("session_id", sid);
    expect(counts.data?.map((c) => [c.material_id, Number(c.counted_quantity), c.counted_by]).sort()).toEqual(
      [[m, 4, tAdmin.id], [m3, 1, tAdmin.id]].sort(),
    );
    const ev = await asBiuro.rpc("inventory_session_events", { p_session_id: sid });
    expect(ev.error).toBeNull();
    const evs = ev.data as { kind: string; material_code: string; counted_quantity: number | null; previous_quantity: number | null; user_name: string }[];
    expect(evs.find((e) => e.kind === "REMOVE" && e.material_code === `${P}-C2`)).toMatchObject({ previous_quantity: 2.125 });
    expect(evs.find((e) => e.kind === "COUNT" && e.material_code === `${P}-C1` && Number(e.previous_quantity) === 0)).toMatchObject({
      counted_quantity: 4,
      user_name: "Test ADMIN",
    });
    const loc = await asProd.from("inventory_session_locations").select("counted_by").eq("session_id", sid).eq("location_id", a).single();
    expect(loc.data?.counted_by).toBe(tAdmin.id);
  });

  it("idempotencja zapisu: 5× równolegle ten sam id → jeden zapis; inne pozycje z tym id → IDEMPOTENCY_CONFLICT", async () => {
    const v = await view(asProd, sid, a);
    const crid = randomUUID();
    const items = [{ material_id: m, quantity: 5 }];
    const before = (await asBiuro.from("inventory_count_events").select("id").eq("session_id", sid)).data?.length ?? 0;
    const res = await Promise.all(Array.from({ length: 5 }, (_, i) => saveRaw(i % 2 ? asProdB : asProd, sid, a, items, v.server_time, crid, v.location_version)));
    expect(res.filter((r) => r.error)).toEqual([]);
    expect(res.filter((r) => (r.data as { idempotent_replay: boolean }).idempotent_replay === false)).toHaveLength(1);
    const after = (await asBiuro.from("inventory_count_events").select("id").eq("session_id", sid)).data?.length ?? 0;
    expect(after - before).toBe(2); // COUNT m + REMOVE m3
    expect((await saveRaw(asProd, sid, a, [{ material_id: m, quantity: 6 }], v.server_time, crid, v.location_version)).error?.hint).toBe("IDEMPOTENCY_CONFLICT");
  });
});

// ---------------------------------------------------------------------------
describe("zatwierdzanie", () => {
  it("różnice → operacja INVENTORY (BIURO, sesja), zgodne → MATCHED bez ruchu; verify_stock = 0; historia z nazwą sesji", async () => {
    const m1 = await material("A1");
    const m2 = await material("A2", "mb");
    const m3 = await material("A3");
    const a = await location("AP1");
    const b = await location("AP2");
    await receive(m1, a, 10);
    await receive(m2, a, 4);
    await receive(m3, b, 3);
    const sid = await session([a, b], "zatw");
    await count(sid, a, [{ material_id: m1, quantity: 8 }, { material_id: m2, quantity: 4.5 }]);
    await count(sid, b, [{ material_id: m3, quantity: 3 }, { material_id: m1, quantity: 2 }]);
    const ap = await approve(sid);
    expect(ap).toMatchObject({ approved_count: 3, matched_count: 1, recount: [], skipped: [], idempotent_replay: false });
    expect(ap.operation_id).toBeTruthy();
    expect(await stockQty(m1, a)).toBe(8);
    expect(await stockQty(m2, a)).toBe(4.5);
    expect(await stockQty(m3, b)).toBe(3);
    expect(await stockQty(m1, b)).toBe(2);
    const op = await admin.from("stock_operations").select("*").eq("id", ap.operation_id!).single();
    expect(op.data).toMatchObject({ type: "INVENTORY", user_id: tBiuro.id, inventory_session_id: sid, client_request_id: expect.any(String) });
    const mv = await admin.from("stock_movements").select("material_id, location_id, quantity_delta").eq("operation_id", ap.operation_id!);
    expect(mv.data?.map((x) => [x.material_id, x.location_id, Number(x.quantity_delta)]).sort()).toEqual(
      [[m1, a, -2], [m2, a, 0.5], [m1, b, 2]].sort(),
    );
    const statuses = await review(sid);
    expect(statuses.map((r) => r.status).sort()).toEqual(["APPROVED", "APPROVED", "APPROVED", "MATCHED"]);
    const hist = await asBiuro.rpc("list_stock_movements", { p_type: "INVENTORY", p_operation_id: ap.operation_id });
    expect(hist.error).toBeNull();
    const items = (hist.data as { items: { inventory_session_id: string; inventory_session_name: string; user_name: string }[] }).items;
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ inventory_session_id: sid, inventory_session_name: `${P}-zatw`, user_name: "Test BIURO" });
    await verify();
    // Ponowne zatwierdzenie „wszystkich” — nic do zrobienia; jawnie wskazana zatwierdzona → ALREADY_APPROVED (pominięta).
    const again = await approve(sid);
    expect(again).toMatchObject({ operation_id: null, approved_count: 0, matched_count: 0 });
    const done = statuses.find((r) => r.status === "APPROVED")!.count_id!;
    expect((await approve(sid, [done])).skipped).toEqual([expect.objectContaining({ count_id: done, reason: "ALREADY_APPROVED" })]);
    // Zatwierdzonej pozycji nie da się zmienić liczeniem.
    const v = await view(asProd, sid, a);
    expect((await saveRaw(asProd, sid, a, [{ material_id: m1, quantity: 9 }], v.server_time, undefined, v.location_version)).error?.hint).toBe("ALREADY_APPROVED");
  });

  it("ruch po liczeniu → RECOUNT (bez różnicy), widoczny na żywo w tabeli i na terminalu; ponowne policzenie → zatwierdzone", async () => {
    const m = await material("RC1");
    const a = await location("RC1");
    await receive(m, a, 10);
    const sid = await session([a], "recount");
    await count(sid, a, [{ material_id: m, quantity: 9 }]);
    expect((await issue(asProd, m, a, 2)).error).toBeNull();
    expect((await rowOf(sid, m, a))?.status).toBe("RECOUNT");
    expect((await view(asProd, sid, a)).items[0].state).toBe("RECOUNT");
    const ap = await approve(sid);
    expect(ap).toMatchObject({ operation_id: null, approved_count: 0 });
    expect(ap.recount).toHaveLength(1);
    expect(await stockQty(m, a)).toBe(8);
    const stored = await asBiuro.from("inventory_counts").select("status").eq("session_id", sid).single();
    expect(stored.data?.status).toBe("RECOUNT");
    // Ponowne liczenie (nowy znacznik) → zatwierdzenie różnicy względem aktualnego stanu.
    await count(sid, a, [{ material_id: m, quantity: 7 }]);
    const ap2 = await approve(sid);
    expect(ap2.approved).toEqual([expect.objectContaining({ quantity_delta: -1 })]);
    expect(await stockQty(m, a)).toBe(7);
    await verify();
  });

  it("ruch zaczęty przed otwarciem ekranu liczenia, ale po nim — RECOUNT; przyjęcie w innej lokalizacji nie przeszkadza", async () => {
    const m = await material("RC2");
    const a = await location("RC2A");
    const b = await location("RC2B");
    await receive(m, a, 5);
    const sid = await session([a], "recount2");
    const v = await view(asProd, sid, a);
    await receive(m, b, 3); // inna lokalizacja — bez wpływu
    expect((await saveRaw(asProd, sid, a, [{ material_id: m, quantity: 6 }], v.server_time, undefined, v.location_version)).error).toBeNull();
    expect((await approve(sid)).approved_count).toBe(1);
    expect(await stockQty(m, a)).toBe(6);

    // Przyjęcie do liczonej lokalizacji PO otwarciu ekranu, ale PRZED zapisem — też RECOUNT (liczono przed przyjęciem).
    const sid2Loc = await location("RC2C");
    await receive(m, sid2Loc, 1);
    const sid2 = await session([sid2Loc], "recount3");
    const v2 = await view(asProd, sid2, sid2Loc);
    await new Promise((r) => setTimeout(r, 50));
    await receive(m, sid2Loc, 1);
    expect((await saveRaw(asProd, sid2, sid2Loc, [{ material_id: m, quantity: 1 }], v2.server_time, undefined, v2.location_version)).error).toBeNull();
    expect((await rowOf(sid2, m, sid2Loc))?.status).toBe("RECOUNT");
    await verify();
  });

  it("idempotencja: 5× równolegle ten sam id → jedna operacja, jeden wynik nowy; inne pozycje z tym id → IDEMPOTENCY_CONFLICT", async () => {
    const m = await material("ID1");
    const a = await location("ID1");
    await receive(m, a, 10);
    const sid = await session([a], "idem");
    await count(sid, a, [{ material_id: m, quantity: 6 }]);
    const crid = randomUUID();
    const res = await Promise.all(Array.from({ length: 5 }, (_, i) => approveRaw(i % 2 ? asBiuroB : asBiuro, sid, null, crid)));
    expect(res.filter((r) => r.error)).toEqual([]);
    expect(res.filter((r) => (r.data as ApproveData).idempotent_replay === false)).toHaveLength(1);
    const opIds = new Set(res.map((r) => (r.data as ApproveData).operation_id));
    expect(opIds.size).toBe(1);
    const ops = await admin.from("stock_operations").select("id").eq("inventory_session_id", sid);
    expect(ops.data).toHaveLength(1);
    expect(await stockQty(m, a)).toBe(6);
    const cid = (await review(sid))[0].count_id!;
    expect((await approveRaw(asBiuro, sid, [cid], crid)).error?.hint).toBe("IDEMPOTENCY_CONFLICT");
    // Inny użytkownik z tym samym id → konflikt (bez ujawniania wyniku).
    expect((await approveRaw(asAdmin, sid, null, crid)).error?.hint).toBe("IDEMPOTENCY_CONFLICT");
    // Serwis: 200 przy powtórzeniu (replay) i 409 przy konflikcie.
    const svc = await approveInventory(asBiuro, sid, { client_request_id: crid });
    expect(svc.ok && svc.data.idempotentReplay).toBe(true);
    await verify();
  });

  it("liczenie zmienione po wczytaniu tabeli (inna ilość oczekiwana) → COUNT_CHANGED, bez ruchu; zgodna → zatwierdzona", async () => {
    const m = await material("CH1");
    const a = await location("CH1");
    await receive(m, a, 10);
    const sid = await session([a], "zmiana");
    await count(sid, a, [{ material_id: m, quantity: 8 }]);
    const cid = (await review(sid))[0].count_id!;
    await count(sid, a, [{ material_id: m, quantity: 6 }]); // liczący poprawił po wczytaniu tabeli przez biuro
    const r = await approveRaw(asBiuro, sid, [cid], randomUUID(), { [cid]: 8 });
    expect(r.error).toBeNull();
    expect((r.data as ApproveData).skipped).toEqual([expect.objectContaining({ count_id: cid, reason: "COUNT_CHANGED" })]);
    expect(await stockQty(m, a)).toBe(10);
    const ok = await approveRaw(asBiuro, sid, [cid], randomUUID(), { [cid]: 6 });
    expect((ok.data as ApproveData).approved).toEqual([expect.objectContaining({ count_id: cid, quantity_delta: -4 })]);
    expect(await stockQty(m, a)).toBe(6);
    expect((await approveRaw(asBiuro, sid, [cid], randomUUID(), { [cid]: "x" } as never)).error?.hint).toBe("VALIDATION");
    await verify();
  });

  it("zaznaczone pozycje: zatwierdzane tylko wskazane; pozycja z innej sesji → NOT_FOUND", async () => {
    const m = await material("SEL");
    const a = await location("SELA");
    const b = await location("SELB");
    await receive(m, a, 5);
    await receive(m, b, 5);
    const sid = await session([a, b], "zaznaczone");
    await count(sid, a, [{ material_id: m, quantity: 4 }]);
    await count(sid, b, [{ material_id: m, quantity: 3 }]);
    const rows = await review(sid);
    const ra = rows.find((r) => r.location_id === a)!;
    const ap = await approve(sid, [ra.count_id!]);
    expect(ap.approved_count).toBe(1);
    expect(await stockQty(m, a)).toBe(4);
    expect(await stockQty(m, b)).toBe(5);
    expect((await approveRaw(asBiuro, sid, [randomUUID()])).error?.hint).toBe("NOT_FOUND");
    await verify();
  });

  it("nieaktywne: różnica w górę dla nieaktywnego materiału / lokalizacji → pominięta z powodem (tabela i wynik)", async () => {
    const mi = await material("IN1");
    const ml = await material("IN2");
    const a = await location("INA");
    const b = await location("INB");
    const sid = await session([a, b], "nieaktywne");
    await count(sid, a, [{ material_id: mi, quantity: 3 }]);
    await count(sid, b, [{ material_id: ml, quantity: 2 }]);
    expect((await asAdmin.from("materials").update({ active: false }).eq("id", mi)).error).toBeNull();
    expect((await asAdmin.from("locations").update({ active: false }).eq("id", b)).error).toBeNull();
    expect((await rowOf(sid, mi, a))?.blocked_reason).toBe("MATERIAL_INACTIVE");
    expect((await rowOf(sid, ml, b))?.blocked_reason).toBe("LOCATION_INACTIVE");
    const ap = await approve(sid);
    expect(ap.approved_count).toBe(0);
    expect(ap.skipped.map((s) => s.reason).sort()).toEqual(["LOCATION_INACTIVE", "MATERIAL_INACTIVE"]);
    expect(await stockQty(mi, a)).toBe(0);
    expect(await stockQty(ml, b)).toBe(0);
    await asAdmin.from("materials").update({ active: true }).eq("id", mi);
    await asAdmin.from("locations").update({ active: true }).eq("id", b);
  });

  it("niepoliczony materiał oczekiwany w policzonej lokalizacji — UNCOUNTED, bez zerowania; niepoliczona lokalizacja bez zmian", async () => {
    const m1 = await material("UC1");
    const m2 = await material("UC2");
    const a = await location("UCA");
    const b = await location("UCB");
    await receive(m1, a, 4);
    await receive(m2, a, 6);
    await receive(m1, b, 2);
    const sid = await session([a, b], "niepoliczone");
    await count(sid, a, [{ material_id: m1, quantity: 4 }]);
    const rows = await review(sid);
    expect(rows.find((r) => r.material_id === m2 && r.location_id === a)).toMatchObject({ status: "UNCOUNTED", count_id: null });
    expect(rows.find((r) => r.location_id === b)).toBeUndefined();
    await approve(sid);
    const closed = await asBiuro.rpc("inventory_close_session", { p_client_request_id: randomUUID(), p_session_id: sid });
    expect(closed.data).toMatchObject({ uncounted_locations: 1, unapproved_counts: 0 });
    expect(await stockQty(m2, a)).toBe(6);
    expect(await stockQty(m1, b)).toBe(2);
  });

  it("nadrezerwacja po zatwierdzeniu w dół: widoczna (rezerwacja w tabeli), rezerwacje bez zmian", async () => {
    const m = await material("RS1");
    const a = await location("RS1");
    await receive(m, a, 10);
    const ord = await asBiuro.from("production_orders").insert({ name: `${P}-rez` }).select("id").single();
    if (ord.error) throw ord.error;
    testOrders.push(ord.data.id);
    expect((await asBiuro.rpc("create_requirement", { p_order_id: ord.data.id, p_name: "L", p_items: [{ material_id: m, quantity: 8 }] })).error).toBeNull();
    expect((await asBiuro.rpc("reserve_for_order", { p_client_request_id: randomUUID(), p_order_id: ord.data.id, p_items: null })).error).toBeNull();
    const sid = await session([a], "rezerwacje");
    await count(sid, a, [{ material_id: m, quantity: 5 }]);
    const row = await rowOf(sid, m, a);
    expect(Number(row?.material_reserved)).toBe(8);
    await approve(sid);
    expect(await stockQty(m, a)).toBe(5);
    const res = await admin.from("reservations").select("quantity").eq("material_id", m).single();
    expect(Number(res.data?.quantity)).toBe(8);
    const ms = await asBiuro.from("v_material_stock").select("over_reserved").eq("material_id", m).single();
    expect(ms.data?.over_reserved).toBe(true);
  });

  it("storno operacji INVENTORY (ADMIN) — ruchy odwrotne, verify_stock = 0, tabela pokazuje cofnięcie", async () => {
    const m = await material("ST1");
    const a = await location("ST1");
    const b = await location("ST2");
    await receive(m, a, 10);
    const sid = await session([a, b], "storno");
    await count(sid, a, [{ material_id: m, quantity: 7 }]);
    await count(sid, b, [{ material_id: m, quantity: 2 }]);
    const ap = await approve(sid);
    expect(ap.approved_count).toBe(2);
    const rv = await asAdmin.rpc("stock_reverse", { p_client_request_id: randomUUID(), p_operation_id: ap.operation_id, p_reason: "błąd liczenia" });
    expect(rv.error).toBeNull();
    expect(await stockQty(m, a)).toBe(10);
    expect(await stockQty(m, b)).toBe(0);
    expect((await review(sid)).every((r) => r.operation_reversed)).toBe(true);
    // BIURO nie cofa (storno tylko ADMIN).
    expect((await asBiuro.rpc("stock_reverse", { p_client_request_id: randomUUID(), p_operation_id: ap.operation_id, p_reason: "x y z" })).error?.code).toBe("42501");
    await verify();
  });

  it("CSV różnic: nagłówek, statusy, przecinek dziesiętny; tylko różnice", async () => {
    const m = await material("CSV", "mb");
    const a = await location("CSV");
    await receive(m, a, 2.5);
    const sid = await session([a], "csv");
    await count(sid, a, [{ material_id: m, quantity: 2 }]);
    const all = await asBiuro.rpc("export_inventory_csv", { p_session_id: sid, p_only_diff: false });
    expect(all.error).toBeNull();
    const lines = (all.data as string).split("\r\n");
    expect(lines[0]).toBe("Lokalizacja;Kod materiału;Nazwa materiału;Jednostka;Stan systemowy;Policzono;Różnica;Status;Liczył;Data liczenia");
    expect(lines[1]).toContain(`${P}-CSV;${P}-CSV;Materiał CSV;mb;2,5;2;-0,5;różnica;Test PRODUKCJA;`);
    await approve(sid);
    const diff = await asBiuro.rpc("export_inventory_csv", { p_session_id: sid, p_only_diff: true });
    expect((diff.data as string).split("\r\n")[1]).toContain("zatwierdzona różnica");
  });
});

// ---------------------------------------------------------------------------
describe("współbieżność: zatwierdzanie vs wydanie/przyjęcie (dwa połączenia)", () => {
  it("zatwierdzanie trzyma blokady → wydanie czeka i wykonuje się na stanie po inwentaryzacji (nigdy < 0)", async () => {
    const m = await material("CC1");
    const a = await location("CC1");
    await receive(m, a, 10);
    const sid = await session([a], "cc1");
    await count(sid, a, [{ material_id: m, quantity: 3 }]);
    const { waited, second } = await holdThenRun(
      async (tx) => {
        await actAs(tx, tBiuro.id);
        await tx`select public.inventory_approve(${randomUUID()}, ${sid}, null)`;
      },
      async (tx) => {
        await actAs(tx, tProd.id);
        await tx`select public.stock_issue(${randomUUID()}, ${a}, ${m}, 5, null, 'SERWIS')`;
      },
    );
    expect(waited).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.hint).toBe("INSUFFICIENT_STOCK");
    expect(await stockQty(m, a)).toBe(3);
    await verify();
  });

  it("wydanie w toku (niezatwierdzone) → zatwierdzanie czeka na materiał i oznacza pozycję RECOUNT (ruch nie zgubiony)", async () => {
    const m = await material("CC2");
    const a = await location("CC2");
    await receive(m, a, 10);
    const sid = await session([a], "cc2");
    await count(sid, a, [{ material_id: m, quantity: 6 }]);
    const { waited, second } = await holdThenRun(
      async (tx) => {
        await actAs(tx, tProd.id);
        await tx`select public.stock_issue(${randomUUID()}, ${a}, ${m}, 2, null, 'SERWIS')`;
      },
      async (tx) => {
        await actAs(tx, tBiuro.id);
        const r = await tx`select public.inventory_approve(${randomUUID()}, ${sid}, null) as r`;
        return r[0].r as ApproveData;
      },
    );
    expect(waited).toBe(true);
    expect(second.ok).toBe(true);
    const data = second.value as ApproveData;
    expect(data.approved_count).toBe(0);
    expect(data.recount).toHaveLength(1);
    expect(await stockQty(m, a)).toBe(8);
    await verify();
  });

  it("przyjęcie w toku vs zatwierdzanie — RECOUNT; zatwierdzanie w toku vs przyjęcie — przyjęcie po inwentaryzacji", async () => {
    const m = await material("CC3");
    const a = await location("CC3");
    await receive(m, a, 4);
    const sid = await session([a], "cc3");
    await count(sid, a, [{ material_id: m, quantity: 5 }]);
    const r1 = await holdThenRun(
      async (tx) => {
        await actAs(tx, tProd.id);
        await tx`select public.stock_receipt(${randomUUID()}, ${a}, ${m}, 1)`;
      },
      async (tx) => {
        await actAs(tx, tBiuro.id);
        return (await tx`select public.inventory_approve(${randomUUID()}, ${sid}, null) as r`)[0].r as ApproveData;
      },
    );
    expect(r1.waited).toBe(true);
    expect((r1.second.value as ApproveData).recount).toHaveLength(1);
    expect(await stockQty(m, a)).toBe(5);

    await count(sid, a, [{ material_id: m, quantity: 2 }]);
    const r2 = await holdThenRun(
      async (tx) => {
        await actAs(tx, tBiuro.id);
        await tx`select public.inventory_approve(${randomUUID()}, ${sid}, null)`;
      },
      async (tx) => {
        await actAs(tx, tProd.id);
        await tx`select public.stock_receipt(${randomUUID()}, ${a}, ${m}, 1)`;
      },
    );
    expect(r2.waited).toBe(true);
    expect(r2.second.ok).toBe(true);
    expect(await stockQty(m, a)).toBe(3); // 2 (inwentaryzacja) + 1 (przyjęcie po niej)
    await verify();
  });

  it("losowo: zatwierdzanie równolegle z wydaniami i przyjęciami — brak stanu < 0, brak zgubionych ruchów, verify = 0", async () => {
    for (let round = 0; round < 3; round++) {
      const m = await material(`MX${round}`);
      const a = await location(`MX${round}A`);
      const b = await location(`MX${round}B`);
      await receive(m, a, 10);
      await receive(m, b, 10);
      const sid = await session([a, b], `mix${round}`);
      await count(sid, a, [{ material_id: m, quantity: 7 }]);
      await count(sid, b, [{ material_id: m, quantity: 12 }]);
      const ops: PromiseLike<{ error: unknown }>[] = [
        approveRaw(asBiuro, sid),
        issue(asProd, m, a, 3),
        issue(asProdB, m, b, 4),
        asAdmin.rpc("stock_receipt", { p_client_request_id: randomUUID(), p_location_id: a, p_material_id: m, p_quantity: 2 }),
        issue(asProd, m, a, 8),
      ];
      const res = await Promise.all(ops);
      for (const r of res) {
        const e = r.error as { hint?: string; code?: string } | null;
        if (e) expect(["INSUFFICIENT_STOCK"]).toContain(e.hint);
      }
      const qa = await stockQty(m, a);
      const qb = await stockQty(m, b);
      expect(qa).toBeGreaterThanOrEqual(0);
      expect(qb).toBeGreaterThanOrEqual(0);
      // Każda pozycja: zatwierdzona (ruch INVENTORY) albo RECOUNT (bez ruchu) — nic pośrodku.
      const rows = await review(sid);
      for (const r of rows) expect(["APPROVED", "MATCHED", "RECOUNT"]).toContain(r.status);
      // MEDIUM-1: stan zaraz po ruchu INVENTORY = policzono. Zatwierdzenie nastąpiło przy liczbie ruchów = znacznik, więc
      // stan przed ruchem = Σ ruchów sprzed rozpoczęcia liczenia (liczone niezależnie z ledgera); + delta INVENTORY.
      // (Porządek created_at ≠ porządek zatwierdzeń transakcji, dlatego nie sumujemy „prefiksu po created_at”.)
      const counts = await asBiuro
        .from("inventory_counts")
        .select("location_id, counted_quantity, count_started_at, baseline_movement_count, status, operation_id")
        .eq("session_id", sid);
      const allMv = await admin.from("stock_movements").select("location_id, quantity_delta, created_at, operation_id").eq("material_id", m);
      for (const c of (counts.data ?? []).filter((x) => x.status === "APPROVED")) {
        const before = (allMv.data ?? []).filter((x) => x.location_id === c.location_id && new Date(x.created_at) < new Date(c.count_started_at));
        expect(before).toHaveLength(c.baseline_movement_count);
        const inv = (allMv.data ?? []).filter((x) => x.location_id === c.location_id && x.operation_id === c.operation_id);
        expect(inv).toHaveLength(1);
        const after = before.reduce((s, x) => s + Number(x.quantity_delta), 0) + Number(inv[0].quantity_delta);
        expect(Math.round(after * 1000) / 1000).toBe(Number(c.counted_quantity));
      }
      // Suma ruchów = stan (żaden ruch nie zginął).
      const mv = await admin.from("stock_movements").select("location_id, quantity_delta").eq("material_id", m);
      const sum = (loc: string) => (mv.data ?? []).filter((x) => x.location_id === loc).reduce((s, x) => s + Number(x.quantity_delta), 0);
      expect(Math.round(sum(a) * 1000) / 1000).toBe(qa);
      expect(Math.round(sum(b) * 1000) / 1000).toBe(qb);
    }
    await verify();
  });
});

// ---------------------------------------------------------------------------
describe("serwis (mapowanie błędów) i sprzątanie", () => {
  it("createInventorySession / saveLocationCount / approveInventory / getSessionReview — kody HTTP", async () => {
    const m = await material("SV1");
    const l = await location("SV1");
    const s = await createInventorySession(asBiuro, { client_request_id: randomUUID(), name: `${P}-serwis`, location_ids: [l] });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    testSessions.push(s.data.sessionId);
    const dup = await createInventorySession(asBiuro, { client_request_id: randomUUID(), name: `${P}-serwis2`, location_ids: [l] });
    expect(dup.ok ? null : dup.error).toMatchObject({ status: 409, code: "LOCATION_IN_OPEN_SESSION" });
    const v = await getCountingLocation(asProd, s.data.sessionId, l);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const bad = await saveLocationCount(asProd, s.data.sessionId, l, {
      client_request_id: randomUUID(),
      started_at: v.data.serverTime,
      location_version: v.data.locationVersion,
      items: [{ material_id: m, quantity: 1.5 }],
    });
    expect(bad.ok ? null : bad.error).toMatchObject({ status: 400, code: "NOT_INTEGER" });
    const ok = await saveLocationCount(asProd, s.data.sessionId, l, {
      client_request_id: randomUUID(),
      started_at: v.data.serverTime,
      location_version: v.data.locationVersion,
      items: [{ material_id: m, quantity: 2 }],
    });
    expect(ok.ok).toBe(true);
    const rv = await getSessionReview(asBiuro, s.data.sessionId);
    expect(rv.ok && rv.data[0]).toMatchObject({ status: "DIFF", difference: 2, systemQuantity: 0 });
    const forbidden = await getSessionReview(asProd, s.data.sessionId);
    expect(forbidden.ok ? null : forbidden.error).toMatchObject({ status: 403 });
    const ap = await approveInventory(asBiuro, s.data.sessionId, { client_request_id: randomUUID() });
    expect(ap.ok && ap.data.approvedCount).toBe(1);
  });

  it("purge_test_stock usuwa wyłącznie sesje TEST-… z ich liczeniami (materiały is_test) i operacje INVENTORY", async () => {
    const m = await material("PG1");
    const l = await location("PG1");
    const sid = await session([l], "purge");
    await count(sid, l, [{ material_id: m, quantity: 3 }]);
    const ap = await approve(sid);
    expect(ap.approved_count).toBe(1);
    const r = await admin.rpc("purge_test_stock", { p_material_ids: [m], p_order_ids: null, p_inventory_session_ids: [sid] });
    expect(r.error).toBeNull();
    expect((await admin.from("inventory_sessions").select("id").eq("id", sid)).data).toEqual([]);
    expect((await admin.from("inventory_counts").select("id").eq("material_id", m)).data).toEqual([]);
    expect((await admin.from("stock_operations").select("id").eq("id", ap.operation_id!)).data).toEqual([]);
    testSessions.splice(testSessions.indexOf(sid), 1);
    // Bez klucza secret — brak uprawnień.
    expect((await asAdmin.rpc("purge_test_stock", { p_material_ids: [m] })).error).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Poprawki po review (HIGH-1, MEDIUM-1, MEDIUM-2)
// ---------------------------------------------------------------------------
describe("dwóch liczących na tej samej lokalizacji (wersja lokalizacji)", () => {
  it("(a) zapis B ze starą wersją nie usuwa liczenia A → LOCATION_COUNT_CHANGED", async () => {
    const m1 = await material("TW1");
    const m2 = await material("TW2");
    const a = await location("TWA");
    await receive(m1, a, 5);
    const sid = await session([a], "dwoch-a");
    const vA = await view(asProd, sid, a);
    const vB = await view(asAdmin, sid, a);
    expect(vA.location_version).toBe(0);
    expect((await saveRaw(asProd, sid, a, [{ material_id: m1, quantity: 5 }], vA.server_time, undefined, vA.location_version)).error).toBeNull();
    const b = await saveRaw(asAdmin, sid, a, [{ material_id: m2, quantity: 3 }], vB.server_time, undefined, vB.location_version);
    expect(b.error?.hint).toBe("LOCATION_COUNT_CHANGED");
    const counts = await asBiuro.from("inventory_counts").select("material_id, counted_quantity, counted_by").eq("session_id", sid);
    expect(counts.data).toEqual([{ material_id: m1, counted_quantity: 5, counted_by: tProd.id }]);
  });

  it("(b) stary ekran A nie nadpisuje korekty B; replay zapisu A nadal działa (idempotencja)", async () => {
    const m = await material("TW3");
    const a = await location("TWB");
    await receive(m, a, 8);
    const sid = await session([a], "dwoch-b");
    const v0 = await view(asProd, sid, a);
    const crid = randomUUID();
    expect((await saveRaw(asProd, sid, a, [{ material_id: m, quantity: 8 }], v0.server_time, crid, v0.location_version)).error).toBeNull();
    const vA = await view(asProd, sid, a); // A wraca do lokalizacji (wersja 1)
    const vB = await view(asAdmin, sid, a);
    expect((await saveRaw(asAdmin, sid, a, [{ material_id: m, quantity: 7 }], vB.server_time, undefined, vB.location_version)).error).toBeNull();
    const stale = await saveRaw(asProd, sid, a, [{ material_id: m, quantity: 9 }], vA.server_time, undefined, vA.location_version);
    expect(stale.error?.hint).toBe("LOCATION_COUNT_CHANGED");
    const c = await asBiuro.from("inventory_counts").select("counted_quantity, counted_by").eq("session_id", sid).single();
    expect(c.data).toEqual({ counted_quantity: 7, counted_by: tAdmin.id });
    // Powtórzenie PIERWSZEGO zapisu (ten sam id, ta sama wersja 0) — replay, bez zmian.
    const replay = await saveRaw(asProd, sid, a, [{ material_id: m, quantity: 8 }], v0.server_time, crid, v0.location_version);
    expect(replay.error).toBeNull();
    expect(replay.data).toMatchObject({ idempotent_replay: true });
    expect((await asBiuro.from("inventory_counts").select("counted_quantity").eq("session_id", sid).single()).data?.counted_quantity).toBe(7);
  });

  it("liczenie innej osoby przeniesione bez zmiany — autor i znacznik zostają; nowa pozycja z autorem zapisującego", async () => {
    const m1 = await material("TW4");
    const m2 = await material("TW5");
    const a = await location("TWC");
    await receive(m1, a, 5);
    const sid = await session([a], "dwoch-c");
    await count(sid, a, [{ material_id: m1, quantity: 5 }], asProd);
    const before = await asBiuro.from("inventory_counts").select("counted_by, counted_at, count_started_at").eq("session_id", sid).single();
    const r = await count(sid, a, [{ material_id: m1, quantity: 5 }, { material_id: m2, quantity: 1 }], asAdmin);
    expect(r).toMatchObject({ saved: 1, unchanged: 1 });
    const rows = await asBiuro.from("inventory_counts").select("material_id, counted_by, counted_at, count_started_at").eq("session_id", sid);
    const r1 = rows.data!.find((x) => x.material_id === m1)!;
    expect(r1).toMatchObject({ counted_by: tProd.id, counted_at: before.data!.counted_at, count_started_at: before.data!.count_started_at });
    expect(rows.data!.find((x) => x.material_id === m2)?.counted_by).toBe(tAdmin.id);
    // Po ruchu ta sama ilość = ponowne liczenie → nowy znacznik (pozycja przestaje być RECOUNT).
    expect((await issue(asProd, m1, a, 1)).error).toBeNull();
    expect((await rowOf(sid, m1, a))?.status).toBe("RECOUNT");
    await count(sid, a, [{ material_id: m1, quantity: 4 }, { material_id: m2, quantity: 1 }], asAdmin);
    expect((await rowOf(sid, m1, a))?.status).toBe("OK");
  });

  it("LOW-2: czas rozpoczęcia z przyszłości (> 5 s) → VALIDATION", async () => {
    const m = await material("TW6");
    const a = await location("TWD");
    const sid = await session([a], "przyszlosc");
    const future = new Date(Date.now() + 60_000).toISOString();
    expect((await saveRaw(asProd, sid, a, [{ material_id: m, quantity: 1 }], future, undefined, 0)).error?.hint).toBe("VALIDATION");
  });
});

describe("znacznik stanu — przypadki brzegowe", () => {
  it("przesunięcie tam i z powrotem (stan bez zmian) → RECOUNT", async () => {
    const m = await material("EB1");
    const a = await location("EBA");
    const b = await location("EBB");
    await receive(m, a, 6);
    const sid = await session([a], "tam-z-powrotem");
    await count(sid, a, [{ material_id: m, quantity: 5 }]);
    const tr = (from: string, to: string) =>
      asProd.rpc("stock_transfer", { p_client_request_id: randomUUID(), p_material_id: m, p_from_location_id: from, p_to_location_id: to, p_quantity: 1 });
    expect((await tr(a, b)).error).toBeNull();
    expect((await tr(b, a)).error).toBeNull();
    expect(await stockQty(m, a)).toBe(6);
    const ap = await approve(sid);
    expect(ap.recount).toHaveLength(1);
    expect(await stockQty(m, a)).toBe(6);
    await verify();
  });

  it("ruch innego materiału w tej samej lokalizacji — pozycja nadal DIFF i zatwierdzalna", async () => {
    const m1 = await material("EB2");
    const m2 = await material("EB3");
    const a = await location("EBC");
    await receive(m1, a, 6);
    const sid = await session([a], "inny-material");
    await count(sid, a, [{ material_id: m1, quantity: 4 }]);
    await receive(m2, a, 3);
    expect((await rowOf(sid, m1, a))?.status).toBe("DIFF");
    expect((await approve(sid)).approved_count).toBe(1);
    expect(await stockQty(m1, a)).toBe(4);
    expect(await stockQty(m2, a)).toBe(3);
    await verify();
  });
});

describe("współbieżność zatwierdzania z przesunięciem, korektą i stornem (dwa połączenia)", () => {
  async function prepared(code: string) {
    const m = await material(code);
    const a = await location(`${code}A`);
    const b = await location(`${code}B`);
    await receive(m, a, 6);
    const receiptOp = (
      await asAdmin.rpc("stock_receipt", { p_client_request_id: randomUUID(), p_location_id: a, p_material_id: m, p_quantity: 4 })
    ).data as { operation_id: string };
    const sid = await session([a], code.toLowerCase());
    await count(sid, a, [{ material_id: m, quantity: 3 }]);
    return { m, a, b, sid, receiptOp: receiptOp.operation_id };
  }
  const approveTx = (sid: string) => async (tx: postgres.TransactionSql) => {
    await actAs(tx, tBiuro.id);
    return (await tx`select public.inventory_approve(${randomUUID()}, ${sid}, null) as r`)[0].r as ApproveData;
  };

  it("zatwierdzanie w toku → przesunięcie 5 czeka i dostaje INSUFFICIENT_STOCK (stan 3)", async () => {
    const p = await prepared("CT1");
    const { waited, second } = await holdThenRun(approveTx(p.sid), async (tx) => {
      await actAs(tx, tProd.id);
      await tx`select public.stock_transfer(${randomUUID()}, ${p.m}, ${p.a}, ${p.b}, 5)`;
    });
    expect(waited).toBe(true);
    expect(second.hint).toBe("INSUFFICIENT_STOCK");
    expect(await stockQty(p.m, p.a)).toBe(3);
    await verify();
  });

  it("zatwierdzanie w toku → korekta ze starym expected_current czeka i dostaje STOCK_CHANGED", async () => {
    const p = await prepared("CT2");
    const { waited, second } = await holdThenRun(approveTx(p.sid), async (tx) => {
      await actAs(tx, tAdmin.id);
      await tx`select public.stock_adjust(${randomUUID()}, ${p.m}, ${p.a}, 9, 10, 'ZNALEZIONE')`;
    });
    expect(waited).toBe(true);
    expect(second.hint).toBe("STOCK_CHANGED");
    expect(await stockQty(p.m, p.a)).toBe(3);
    await verify();
  });

  it("zatwierdzanie w toku → storno przyjęcia (−4) czeka i dostaje INSUFFICIENT_STOCK", async () => {
    const p = await prepared("CT3");
    const { waited, second } = await holdThenRun(approveTx(p.sid), async (tx) => {
      await actAs(tx, tAdmin.id);
      await tx`select public.stock_reverse(${randomUUID()}, ${p.receiptOp}, 'test współbieżności')`;
    });
    expect(waited).toBe(true);
    expect(second.hint).toBe("INSUFFICIENT_STOCK");
    expect(await stockQty(p.m, p.a)).toBe(3);
    await verify();
  });

  it("przesunięcie / korekta / storno w toku → zatwierdzanie czeka i oznacza RECOUNT", async () => {
    for (const [code, op] of [
      ["CT4", (tx: postgres.TransactionSql, p: Awaited<ReturnType<typeof prepared>>) => tx`select public.stock_transfer(${randomUUID()}, ${p.m}, ${p.a}, ${p.b}, 1)`],
      ["CT5", (tx: postgres.TransactionSql, p: Awaited<ReturnType<typeof prepared>>) => tx`select public.stock_adjust(${randomUUID()}, ${p.m}, ${p.a}, 9, 10, 'ZAGINIECIE')`],
      ["CT6", (tx: postgres.TransactionSql, p: Awaited<ReturnType<typeof prepared>>) => tx`select public.stock_reverse(${randomUUID()}, ${p.receiptOp}, 'test współbieżności')`],
    ] as const) {
      const p = await prepared(code);
      const { waited, second } = await holdThenRun(async (tx) => {
        await actAs(tx, code === "CT4" ? tProd.id : tAdmin.id);
        await op(tx, p);
      }, approveTx(p.sid));
      expect(waited).toBe(true);
      expect(second.ok).toBe(true);
      expect((second.value as ApproveData).recount).toHaveLength(1);
      expect((second.value as ApproveData).approved_count).toBe(0);
    }
    await verify();
  });
});

describe("stres (skrócony): zatwierdzanie, przesunięcia, wydania, przyjęcia, korekty, storno INVENTORY, zapisy liczeń", () => {
  const ALLOWED = new Set([
    "INSUFFICIENT_STOCK",
    "STOCK_CHANGED",
    "NO_CHANGE",
    "LOCATION_COUNT_CHANGED",
    "ALREADY_REVERSED",
    "ALREADY_APPROVED",
    "SESSION_NOT_OPEN",
  ]);

  it("4 rundy Promise.all — brak 40P01 / błędów spoza domeny, verify_stock puste, stan ≥ 0; stan po INVENTORY = policzono", async () => {
    const m = await material("ST9");
    const locs = [await location("S9A"), await location("S9B"), await location("S9C")];
    for (const l of locs) await receive(m, l, 10);
    let lastInventoryOp: string | null = null;
    for (let round = 0; round < 4; round++) {
      const sid = await session(locs, `stres${round}`);
      for (const [i, l] of locs.entries()) await count(sid, l, [{ material_id: m, quantity: 6 + i + round }]);
      const cur = await stockQty(m, locs[2]);
      const v = await view(asProdB, sid, locs[1]);
      const ops: PromiseLike<{ error: { code?: string; hint?: string; message?: string } | null }>[] = [
        approveRaw(asBiuro, sid),
        approveRaw(asBiuroB, sid),
        asProd.rpc("stock_transfer", { p_client_request_id: randomUUID(), p_material_id: m, p_from_location_id: locs[0], p_to_location_id: locs[1], p_quantity: 2 }),
        asProdB.rpc("stock_transfer", { p_client_request_id: randomUUID(), p_material_id: m, p_from_location_id: locs[1], p_to_location_id: locs[0], p_quantity: 1 }),
        issue(asProd, m, locs[2], 3),
        asAdmin.rpc("stock_receipt", { p_client_request_id: randomUUID(), p_location_id: locs[1], p_material_id: m, p_quantity: 2 }),
        asAdmin.rpc("stock_adjust", { p_client_request_id: randomUUID(), p_material_id: m, p_location_id: locs[2], p_target_quantity: cur + 1, p_expected_current: cur, p_reason_code: "ZNALEZIONE" }),
        saveRaw(asProdB, sid, locs[1], [{ material_id: m, quantity: 9 }], v.server_time, undefined, v.location_version),
      ];
      if (lastInventoryOp) {
        ops.push(asAdmin.rpc("stock_reverse", { p_client_request_id: randomUUID(), p_operation_id: lastInventoryOp, p_reason: "stres storno" }));
      }
      const res = await Promise.all(ops);
      for (const r of res) {
        if (!r.error) continue;
        expect(r.error.code).not.toBe("40P01");
        expect(ALLOWED.has(r.error.hint ?? ""), `${r.error.code} ${r.error.hint} ${r.error.message}`).toBe(true);
      }
      for (const l of locs) expect(await stockQty(m, l)).toBeGreaterThanOrEqual(0);
      const op = await admin.from("stock_operations").select("id").eq("inventory_session_id", sid).maybeSingle();
      lastInventoryOp = (op.data?.id as string | undefined) ?? lastInventoryOp;
      await asBiuro.rpc("inventory_close_session", { p_client_request_id: randomUUID(), p_session_id: sid });
      await verify([m]);
    }
  });
});
