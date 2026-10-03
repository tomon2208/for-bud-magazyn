import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveImportCodes } from "@/server/import";
import { getOrderIssueSummary } from "@/server/orders";
import { getOrderShortages, getOrderToIssue, listShortages, substituteRequirementItem } from "@/server/requirements";
import { createIssue, listMovements } from "@/server/stock";
import { addMaterialSubstitute, listMaterialSubstitutes, removeMaterialSubstitute } from "@/server/substitutes";
import { adminClient, createTestUser, deleteAllTestUsers, signIn, type TestUser } from "./helpers";

// Etap 12b (ADR 017): odpowiedniki materiałów — pary (ADMIN), wydanie zamiennika (wyłącznie jawnie — ADR 017 H1), bilans zlecenia,
// rezerwacje (SUBSTITUTE_RELEASE), storno, „Podmień”, informacje w brakach / imporcie, idempotencja, współbieżność.
// Dane: materiały is_test z prefiksem TEST-<runId>-; sprzątanie: listy → purge_test_stock → zlecenia → materiały
// (pary usuwa kaskada) → lokalizacje → kategoria.

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
  const r = await asAdmin.rpc("stock_receipt", { p_client_request_id: randomUUID(), p_location_id: locationId, p_material_id: materialId, p_quantity: qty });
  if (r.error) throw r.error;
}

async function requirement(orderId: string, items: { material_id: string; quantity: number | string; note?: string }[], name = "L") {
  const r = await asBiuro.rpc("create_requirement", { p_order_id: orderId, p_name: name, p_items: items });
  if (r.error) throw r.error;
  return (r.data as { requirement_id: string }).requirement_id;
}

async function pair(a: string, b: string) {
  const r = await asAdmin.rpc("add_material_substitute", { p_material_id: a, p_substitute_id: b });
  if (r.error) throw r.error;
  return (r.data as { id: string }).id;
}

type IssueArgs = { order?: string | null; sub?: string | null; crid?: string };
const issue = (client: SupabaseClient, materialId: string, locationId: string, qty: number, a: IssueArgs = {}) =>
  client.rpc("stock_issue", {
    p_client_request_id: a.crid ?? randomUUID(),
    p_location_id: locationId,
    p_material_id: materialId,
    p_quantity: qty,
    p_production_order_id: a.order ?? null,
    p_reason_code: a.order ? null : "SERWIS",
    p_substitute_for: a.sub ?? null,
  });

type IssueOut = { operation_id: string; substitute_for: { material_id: string; code: string } | null; substitute_reservation_released: number; idempotent_replay: boolean };

const substitute = (client: SupabaseClient, reqId: string, from: string, to: string, reason: string | null = null, crid = randomUUID()) =>
  client.rpc("substitute_requirement_item", { p_client_request_id: crid, p_requirement_id: reqId, p_from_material: from, p_to_material: to, p_reason: reason });

async function balance(orderId: string) {
  const r = await asBiuro.rpc("order_shortages", { p_order_id: orderId });
  if (r.error) throw r.error;
  return new Map((r.data as { material_id: string; needed: number; issued: number; remaining: number }[]).map((x) => [x.material_id, { needed: Number(x.needed), issued: Number(x.issued), remaining: Number(x.remaining) }]));
}

async function reserved(orderId: string, materialId: string): Promise<number> {
  const r = await admin.from("reservations").select("quantity").eq("production_order_id", orderId).eq("material_id", materialId).maybeSingle();
  if (r.error) throw r.error;
  return Number(r.data?.quantity ?? 0);
}

async function events(orderId: string) {
  const r = await asBiuro.rpc("order_reservation_events", { p_order_id: orderId });
  if (r.error) throw r.error;
  return (r.data as { type: string; quantity_delta: string; reason: string | null; operation_id: string | null; material_id: string }[]).map((e) => ({
    ...e,
    delta: Number(e.quantity_delta),
  }));
}

async function verify(materialIds: string[]) {
  const v = await admin.rpc("verify_stock", { p_material_ids: materialIds });
  expect(v.error).toBeNull();
  expect(v.data).toEqual([]);
}

async function sumEventsMatches(materialIds: string[]) {
  const res = await admin.from("reservations").select("id, quantity").in("material_id", materialIds);
  for (const r of res.data ?? []) {
    const ev = await admin.from("reservation_events").select("quantity_delta").eq("reservation_id", r.id);
    const sum = (ev.data ?? []).reduce((s, e) => s + Number(e.quantity_delta), 0);
    expect(Math.round(sum * 1000) / 1000).toBe(Number(r.quantity));
  }
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
    const m = await admin.from("materials").delete().like("code", `${P}-%`);
    if (m.error) console.warn("materials delete:", m.error.message);
    await admin.from("locations").delete().like("code", `${P}-%`);
    await admin.from("material_categories").delete().like("name", `${P}-%`);
  } finally {
    await sql?.end();
    await deleteAllTestUsers(admin);
  }
});

// ---------------------------------------------------------------------------
describe("pary odpowiedników", () => {
  it("ADMIN dodaje (symetrycznie, idempotentnie), usuwa; BIURO/PRODUKCJA 42501; walidacje; zapis bezpośredni niemożliwy", async () => {
    const x = await material("P1-X");
    const y = await material("P1-Y");
    const z = await material("P1-Z");
    const off = await material("P1-OFF");
    expect((await asAdmin.from("materials").update({ active: false }).eq("id", off)).error).toBeNull();

    for (const c of [asBiuro, asProd]) {
      expect((await c.rpc("add_material_substitute", { p_material_id: x, p_substitute_id: y })).error?.code).toBe("42501");
    }
    expect((await asAdmin.rpc("add_material_substitute", { p_material_id: x, p_substitute_id: x })).error?.hint).toBe("SAME_MATERIAL");
    expect((await asAdmin.rpc("add_material_substitute", { p_material_id: x, p_substitute_id: off })).error?.hint).toBe("MATERIAL_INACTIVE");
    expect((await asAdmin.rpc("add_material_substitute", { p_material_id: x, p_substitute_id: randomUUID() })).error?.hint).toBe("NOT_FOUND");

    const first = await addMaterialSubstitute(asAdmin, y, x);
    expect(first.ok && first.data.alreadyExisted).toBe(false);
    const again = await addMaterialSubstitute(asAdmin, x, y);
    expect(again.ok && again.data).toEqual({ id: first.ok ? first.data.id : "", alreadyExisted: true });
    await pair(x, z);

    // Symetrycznie: Y widzi X; nieprzechodnie: Y nie widzi Z. PRODUKCJA czyta.
    const ly = await listMaterialSubstitutes(asProd, y);
    expect(ly.ok && ly.data.map((s) => s.materialId)).toEqual([x]);
    const lx = await listMaterialSubstitutes(asBiuro, x);
    expect(lx.ok && lx.data.map((s) => s.materialCode).sort()).toEqual([`${P}-P1-Y`, `${P}-P1-Z`]);

    const [a, b] = [y, z].sort();
    for (const c of [asProd, asBiuro, asAdmin]) {
      expect((await c.from("material_substitutes").insert({ material_a: a, material_b: b })).error?.code).toBe("42501");
    }
    // Klucz secret ma tylko SELECT + DELETE (sprzątanie testów) — INSERT 42501 (przed CHECK-iem).
    expect((await admin.from("material_substitutes").insert({ material_a: a, material_b: b })).error?.code).toBe("42501");

    const pid = first.ok ? first.data.id : "";
    expect((await asBiuro.rpc("remove_material_substitute", { p_id: pid })).error?.code).toBe("42501");
    expect((await removeMaterialSubstitute(asAdmin, pid)).ok).toBe(true);
    const gone = await removeMaterialSubstitute(asAdmin, pid);
    expect(gone.ok ? null : gone.error).toMatchObject({ status: 404 });
  });
});

// ---------------------------------------------------------------------------
describe("wydanie zamiennika i bilans", () => {
  it("jawny zamiennik: pozostało oryginału maleje, zamiennik nie liczy się do siebie; walidacje; podsumowanie i historia", async () => {
    const x = await material("W1-X");
    const y = await material("W1-Y");
    const w = await material("W1-W");
    const a = await location("W1-A");
    await receive(x, a, 2);
    await receive(y, a, 20);
    await receive(w, a, 5);
    await pair(x, y);
    const o = await order("W1");
    await requirement(o, [{ material_id: x, quantity: 6 }]);

    const sh = await getOrderShortages(asBiuro, o);
    expect(sh.ok && sh.data[0]).toMatchObject({ materialId: x, remaining: 6, available: 2, shortage: 4 });
    expect(sh.ok && sh.data[0].substitutes).toEqual([expect.objectContaining({ materialId: y, free: 20, available: 20 })]);
    const ti = await getOrderToIssue(asProd, o);
    expect(ti.ok && ti.data[0].substitutes[0]).toMatchObject({ materialId: y, available: 20 });

    expect((await issue(asProd, y, a, 1, { sub: x })).error?.hint).toBe("ISSUE_TARGET");
    expect((await issue(asProd, y, a, 1, { order: o, sub: y })).error?.hint).toBe("NOT_A_SUBSTITUTE");
    expect((await issue(asProd, w, a, 1, { order: o, sub: x })).error?.hint).toBe("NOT_A_SUBSTITUTE");
    const o9 = await order("W1-9");
    await requirement(o9, [{ material_id: w, quantity: 1 }]);
    const notIn = await createIssue(asProd, { client_request_id: randomUUID(), location_id: a, material_id: y, quantity: 1, production_order_id: o9, substitute_for: x });
    expect(notIn.ok ? null : notIn.error).toMatchObject({ status: 400, code: "NOT_IN_REQUIREMENTS" });

    const crid = randomUUID();
    const r = await createIssue(asProd, { client_request_id: crid, location_id: a, material_id: y, quantity: 3, production_order_id: o, substitute_for: x });
    expect(r.ok && r.data).toMatchObject({ substituteFor: { materialId: x, code: `${P}-W1-X` }, idempotentReplay: false });
    const b = await balance(o);
    expect(b.get(x)).toEqual({ needed: 6, issued: 3, remaining: 3 });
    expect(b.has(y)).toBe(false);
    const op = await admin.from("stock_operations").select("substitute_for_material_id").eq("client_request_id", crid).single();
    expect(op.data).toEqual({ substitute_for_material_id: x });

    // Replay: ta sama jawna wartość → replay; bez niej → konflikt.
    expect((await issue(asProd, y, a, 3, { order: o, sub: x, crid })).data).toMatchObject({ idempotent_replay: true });
    expect((await issue(asProd, y, a, 3, { order: o, crid })).error?.hint).toBe("IDEMPOTENCY_CONFLICT");

    const sum = await getOrderIssueSummary(asBiuro, o);
    expect(sum.ok && sum.data).toEqual([expect.objectContaining({ materialId: y, quantity: 3, substituteFor: expect.objectContaining({ materialId: x }) })]);
    const hist = await listMovements(asBiuro, { orderId: o, page: 1, pageSize: 10 });
    expect(hist.ok && hist.data.items[0]).toMatchObject({ substituteForCode: `${P}-W1-X` });
    await verify([x, y, w]);
  });

  it("bez automatu (H1): wydanie odpowiednika bez p_substitute_for to zwykłe wydanie; ułamkowy zamiennik za materiał bez ułamków → NOT_INTEGER", async () => {
    const x = await material("A1-X");
    const y = await material("A1-Y");
    const mb = await material("A1-MB", "mb");
    const a = await location("A1-A");
    await receive(y, a, 30);
    await receive(mb, a, 10);
    await pair(x, y);
    await pair(x, mb);
    const o = await order("A1");
    await requirement(o, [{ material_id: x, quantity: 4 }]);
    const crid = randomUUID();
    const plain = await issue(asProd, y, a, 1, { order: o, crid });
    expect((plain.data as IssueOut).substitute_for).toBeNull();
    expect((await balance(o)).get(x)).toEqual({ needed: 4, issued: 0, remaining: 4 });
    // Replay zwykłego wydania z jawnym zamiennikiem → konflikt (porównanie jak override).
    expect((await issue(asProd, y, a, 1, { order: o, crid, sub: x })).error?.hint).toBe("IDEMPOTENCY_CONFLICT");
    const op = await admin.from("stock_operations").select("substitute_for_material_id").eq("client_request_id", crid).single();
    expect(op.data).toEqual({ substitute_for_material_id: null });
    // M2c: zamiennik mb za XXX w sztukach — tylko całości.
    const frac = await issue(asProd, mb, a, 1.5, { order: o, sub: x });
    expect(frac.error?.hint).toBe("NOT_INTEGER");
    expect(frac.error?.details).toBe(`${P}-A1-X`);
    expect(((await issue(asProd, mb, a, 2, { order: o, sub: x })).data as IssueOut).substitute_for?.material_id).toBe(x);
    expect((await balance(o)).get(x)?.remaining).toBe(2);
    await verify([x, y, mb]);
  });

  it("L2: zwolnienie rezerwacji oryginału ≤ ilość wydania (nadmiar sprzed wydania zostaje)", async () => {
    const x = await material("L2-X");
    const y = await material("L2-Y");
    const a = await location("L2-A");
    await receive(x, a, 6);
    await receive(y, a, 5);
    await pair(x, y);
    const o = await order("L2");
    await requirement(o, [{ material_id: x, quantity: 3 }]);
    const second = await requirement(o, [{ material_id: x, quantity: 3 }], "L2b");
    expect((await asBiuro.rpc("reserve_for_order", { p_client_request_id: randomUUID(), p_order_id: o, p_items: null })).error).toBeNull();
    expect(await reserved(o, x)).toBe(6);
    expect((await asBiuro.rpc("withdraw_requirement", { p_requirement_id: second, p_reason: "pomyłka" })).error).toBeNull();
    const r = await issue(asProd, y, a, 1, { order: o, sub: x }); // pozostało 2, rezerwacja 6 → zwolnienie 1 (nie 4)
    expect((r.data as IssueOut).substitute_reservation_released).toBe(1);
    expect(await reserved(o, x)).toBe(5);
    await sumEventsMatches([x, y]);
  });

  it("rezerwacja oryginału ponad nowe pozostało → SUBSTITUTE_RELEASE; storno nie odtwarza rezerwacji; usunięcie pary nie zmienia bilansu", async () => {
    const x = await material("R1-X");
    const y = await material("R1-Y");
    const a = await location("R1-A");
    await receive(x, a, 4);
    await receive(y, a, 10);
    const pid = await pair(x, y);
    const o = await order("R1");
    await requirement(o, [{ material_id: x, quantity: 5 }]);
    expect((await asBiuro.rpc("reserve_for_order", { p_client_request_id: randomUUID(), p_order_id: o, p_items: null })).error).toBeNull();
    expect(await reserved(o, x)).toBe(4);

    const r = await issue(asProd, y, a, 3, { order: o, sub: x }); // pozostało X: 2 → rezerwacja 4 → 2
    expect(r.error).toBeNull();
    expect((r.data as IssueOut).substitute_reservation_released).toBe(2);
    expect(await reserved(o, x)).toBe(2);
    const ev = await events(o);
    expect(ev[0]).toMatchObject({ type: "SUBSTITUTE_RELEASE", delta: -2, operation_id: (r.data as IssueOut).operation_id, material_id: x });
    expect(ev[0].reason).toBe(`Użyto zamiennika ${P}-R1-Y`);

    const rev = await asAdmin.rpc("stock_reverse", { p_client_request_id: randomUUID(), p_operation_id: (r.data as IssueOut).operation_id, p_reason: "pomyłka" });
    expect(rev.error).toBeNull();
    const revOp = await admin.from("stock_operations").select("substitute_for_material_id, production_order_id").eq("id", (rev.data as { operation_id: string }).operation_id).single();
    expect(revOp.data).toEqual({ substitute_for_material_id: x, production_order_id: o });
    expect((await balance(o)).get(x)).toEqual({ needed: 5, issued: 0, remaining: 5 });
    expect(await reserved(o, x)).toBe(2); // bez odtwarzania (ADR 014)

    expect((await issue(asProd, y, a, 1, { order: o, sub: x })).error).toBeNull();
    expect((await removeMaterialSubstitute(asAdmin, pid)).ok).toBe(true);
    expect((await balance(o)).get(x)?.issued).toBe(1); // rozliczenie zapisane w operacji
    expect((await issue(asProd, y, a, 1, { order: o, sub: x })).error?.hint).toBe("NOT_A_SUBSTITUTE");
    await sumEventsMatches([x, y]);
    await verify([x, y]);
  });
});

// ---------------------------------------------------------------------------
describe("Podmień", () => {
  it("wycofanie + kopia (część wydana zostaje, YYY sumowane, plik/format zachowane); idempotencja; błędy; rezerwacja → nadmiar", async () => {
    const x = await material("S1-X");
    const y = await material("S1-Y");
    const w = await material("S1-W");
    const z = await material("S1-Z");
    const a = await location("S1-A");
    await receive(x, a, 10);
    await pair(x, y);
    const o = await order("S1");
    const imp = await asBiuro.rpc("import_requirement", {
      p_order_id: o,
      p_new_order: null,
      p_name: "Lista imp",
      p_file_name: "plik.xls",
      p_import_format: "fmt",
      p_items: [
        { material_id: x, quantity: 10, raw_source_ref: "row X" },
        { material_id: w, quantity: 3, raw_source_ref: "row W" },
        { material_id: y, quantity: 2, note: "orig" },
      ],
      p_client_request_id: randomUUID(),
    });
    expect(imp.error).toBeNull();
    const listId = (imp.data as { requirement_id: string }).requirement_id;
    expect((await issue(asProd, x, a, 4, { order: o })).error).toBeNull();
    expect((await asBiuro.rpc("reserve_for_order", { p_client_request_id: randomUUID(), p_order_id: o, p_items: [{ material_id: x, quantity: 3 }] })).error).toBeNull();

    expect((await substitute(asProd, listId, x, y)).error?.code).toBe("42501");
    expect((await substitute(asBiuro, listId, x, z)).error?.hint).toBe("NOT_A_SUBSTITUTE");
    expect((await substitute(asBiuro, listId, z, x)).error?.hint).toBe("NOT_IN_REQUIREMENTS");
    expect((await substitute(asBiuro, listId, x, x)).error?.hint).toBe("NOT_A_SUBSTITUTE");

    const crid = randomUUID();
    const res = await substituteRequirementItem(asBiuro, listId, { client_request_id: crid, from_material_id: x, to_material_id: y, reason: "klient" });
    expect(res.ok && res.data).toMatchObject({ withdrawnRequirementId: listId, movedQuantity: 6, keptQuantity: 4, idempotentReplay: false });
    const newId = res.ok ? res.data.requirementId : "";
    const old = await admin.from("requirements").select("status, withdraw_reason").eq("id", listId).single();
    expect(old.data).toEqual({ status: "WITHDRAWN", withdraw_reason: `Podmiana ${P}-S1-X → ${P}-S1-Y — klient` });
    const nw = await admin.from("requirements").select("source, name, imported_file_name, import_format, status").eq("id", newId).single();
    expect(nw.data).toEqual({ source: "IMPORT", name: "Lista imp", imported_file_name: "plik.xls", import_format: "fmt", status: "ACTIVE" });
    const items = await admin.from("requirement_items").select("material_id, quantity, note, raw_source_ref").eq("requirement_id", newId);
    const byMat = new Map((items.data ?? []).map((i) => [i.material_id, { q: Number(i.quantity), note: i.note, raw: i.raw_source_ref }]));
    expect(byMat.get(x)).toEqual({ q: 4, note: `wydane przed podmianą na ${P}-S1-Y`, raw: "row X" });
    expect(byMat.get(y)).toEqual({ q: 8, note: `orig; zamiennik za ${P}-S1-X`, raw: "row X" });
    expect(byMat.get(w)).toEqual({ q: 3, note: null, raw: "row W" });
    const b = await balance(o);
    expect([b.get(x)?.remaining, b.get(y)?.remaining]).toEqual([0, 8]);

    // Replay; inny powód / użytkownik → konflikt; wycofana lista → ALREADY_WITHDRAWN; wszystko wydane → NOTHING_TO_SUBSTITUTE.
    const replay = await substituteRequirementItem(asBiuro, listId, { client_request_id: crid, from_material_id: x, to_material_id: y, reason: "klient" });
    expect(replay.ok && replay.data).toMatchObject({ requirementId: newId, idempotentReplay: true });
    expect((await substitute(asBiuro, listId, x, y, "inny", crid)).error?.hint).toBe("IDEMPOTENCY_CONFLICT");
    expect((await substitute(asAdmin, listId, x, y, "klient", crid)).error?.hint).toBe("IDEMPOTENCY_CONFLICT");
    expect((await substitute(asBiuro, listId, x, y)).error?.hint).toBe("ALREADY_WITHDRAWN");
    expect((await substitute(asBiuro, newId, x, y)).error?.hint).toBe("NOTHING_TO_SUBSTITUTE");

    // Rezerwacja X (3) zostaje — nadmiar wobec pozostało X (0), widoczny dla „Zwolnij nadmiar”.
    expect(await reserved(o, x)).toBe(3);
    const over = await asBiuro.rpc("reservations_over_requirement", { p_order_id: o });
    expect(over.data).toEqual([expect.objectContaining({ material_id: x, excess: 3 })]);

    // Zamknięte zlecenie → ORDER_NOT_OPEN.
    expect((await asBiuro.from("production_orders").update({ status: "DONE" }).eq("id", o)).error).toBeNull();
    expect((await substitute(asBiuro, newId, y, x)).error?.hint).toBe("ORDER_NOT_OPEN");
    await verify([x, y, w]);
  });
});

describe("Podmień — XXX z ułamkami, YYY bez ułamków", () => {
  it("na YYY przechodzi część całkowita (floor), ułamek zostaje jako XXX: XF 10, wydano 2,5 → zostaje 3, przenosi 7", async () => {
    const xf = await material("XF-X", "mb");
    const y = await material("XF-Y");
    const a = await location("XF-A");
    await receive(xf, a, 5);
    await pair(xf, y);
    const o = await order("XF");
    const list = await requirement(o, [{ material_id: xf, quantity: 10 }]);
    expect((await issue(asProd, xf, a, 2.5, { order: o })).error).toBeNull();
    const r = await substitute(asBiuro, list, xf, y);
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ kept_quantity: 3, moved_quantity: 7 });
    const b = await balance(o);
    expect([b.get(xf)?.remaining, b.get(y)?.remaining]).toEqual([0.5, 7]);
    await verify([xf, y]);
  });
});

describe("Podmień — nieaktywne pozycje kopii (M2a)", () => {
  it("kopia zawiera materiał nieaktywny z listy źródłowej; create_requirement nadal go odrzuca", async () => {
    const x = await material("M2A-X");
    const y = await material("M2A-Y");
    const q = await material("M2A-Q");
    await pair(x, y);
    const o = await order("M2A");
    const list = await requirement(o, [{ material_id: x, quantity: 2 }, { material_id: q, quantity: 1 }]);
    expect((await asAdmin.from("materials").update({ active: false }).eq("id", q)).error).toBeNull();
    const res = await substitute(asBiuro, list, x, y);
    expect(res.error).toBeNull();
    const items = await admin.from("requirement_items").select("material_id, quantity").eq("requirement_id", (res.data as { requirement_id: string }).requirement_id);
    expect(new Map((items.data ?? []).map((i) => [i.material_id, Number(i.quantity)]))).toEqual(new Map([[q, 1], [y, 2]]));
    const direct = await asBiuro.rpc("create_requirement", { p_order_id: o, p_name: "X", p_items: [{ material_id: q, quantity: 1 }] });
    expect(direct.error?.hint).toBe("MATERIAL_INACTIVE");
  });
});

// ---------------------------------------------------------------------------
describe("informacje: braki zbiorczo, CSV, import", () => {
  it("shortages_summary / CSV / resolve_import_codes zawierają odpowiedniki z wolnym stanem", async () => {
    const x = await material("I1-X");
    const y = await material("I1-Y");
    const a = await location("I1-A");
    await receive(y, a, 7);
    await pair(x, y);
    const o = await order("I1");
    await requirement(o, [{ material_id: x, quantity: 3 }]);
    const all = await listShortages(asBiuro, { onlyShort: true });
    expect(all.ok && all.data.items.find((i) => i.materialId === x)?.substitutes).toEqual([expect.objectContaining({ materialId: y, free: 7 })]);
    const csv = await asBiuro.rpc("export_shortages_csv", { p_supplier_id: null, p_category_id: null, p_only_short: true });
    const lines = (csv.data as string).split("\r\n");
    expect(lines[0].endsWith(";Zlecenia;Odpowiedniki na stanie")).toBe(true);
    expect(lines.find((l) => l.includes(`${P}-I1-X`))?.endsWith(`;${P}-I1-Y (wolne 7)`)).toBe(true);
    const rc = await resolveImportCodes(asBiuro, { codes: [`${P}-I1-X`] });
    expect(rc.ok && rc.data[0].material).toMatchObject({ id: x, free: 0, substitutes: [expect.objectContaining({ materialId: y, free: 7 })] });
  });
});

// ---------------------------------------------------------------------------
describe("współbieżność", () => {
  it("równoległe wydania zamiennika i oryginału na to samo zlecenie (+ rezerwacje): bez 40P01, rezerwacja = Σ zdarzeń, spójne stany", async () => {
    for (let round = 0; round < 3; round++) {
      const x = await material(`C1-${round}-X`);
      const y = await material(`C1-${round}-Y`);
      const a = await location(`C1-${round}-A`);
      await receive(x, a, 6);
      await receive(y, a, 10);
      await pair(x, y);
      const o = await order(`C1-${round}`);
      await requirement(o, [{ material_id: x, quantity: 10 }]);
      expect((await asBiuro.rpc("reserve_for_order", { p_client_request_id: randomUUID(), p_order_id: o, p_items: null })).error).toBeNull();
      const mats = [y, x, y, x, y, x, y];
      const ops = await Promise.all([
        issue(asProd, y, a, 2, { order: o, sub: x }),
        issue(asProdB, x, a, 2, { order: o }),
        issue(asAdmin, y, a, 2, { order: o }),
        issue(asProd, x, a, 2, { order: o }),
        issue(asProdB, y, a, 2, { order: o, sub: x }),
        issue(asAdminB, x, a, 2, { order: o }),
        issue(asProd, y, a, 2, { order: o }),
      ]);
      const codes = ops.filter((r) => r.error).map((r) => r.error?.hint ?? r.error?.code);
      expect(codes).not.toContain("40P01");
      expect(codes.filter((c) => c !== "INSUFFICIENT_STOCK" && c !== "RESERVED_STOCK")).toEqual([]);
      // Bilans X = Σ netto wydań X i zamienników za X; rezerwacja ≤ max(pozostało, 0).
      // Do X liczą się: wydania X oraz wydania Y z jawnym substitute_for = X (Y bez wskazania — zwykłe wydanie).
      const attributed = ops.filter((r, i) => r.error === null && (mats[i] === x || (r.data as IssueOut).substitute_for?.material_id === x)).length * 2;
      const b = (await balance(o)).get(x);
      expect(b?.issued).toBe(attributed);
      expect(b?.issued).toBeGreaterThan(0);
      expect(await reserved(o, x)).toBeLessThanOrEqual(b?.remaining ?? 0);
      await sumEventsMatches([x, y]);
      await verify([x, y]);
    }
  });

  it("mieszanka: wydania zamiennika / oryginału, Podmień, rezerwacja, zwolnienie nadmiaru, zmiana statusu — bez 40P01, spójność", async () => {
    let seed = 4242;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = <T,>(arr: T[]) => arr[Math.floor(rnd() * arr.length)];
    const x = await material("MX-X");
    const y = await material("MX-Y");
    const z = await material("MX-Z");
    const a = await location("MX-A");
    for (const m of [x, y, z]) await receive(m, a, 40);
    await pair(x, y);
    await pair(x, z);
    const orders: string[] = [];
    const lists = new Map<string, string>();
    for (let i = 0; i < 3; i++) {
      const o = await order(`MX-O${i}`);
      orders.push(o);
      lists.set(o, await requirement(o, [{ material_id: x, quantity: 8 }]));
    }
    const codes: string[] = [];
    for (let round = 0; round < 5; round++) {
      const ops: PromiseLike<{ error: { code?: string; hint?: string } | null }>[] = [];
      for (let k = 0; k < 10; k++) {
        const o = pick(orders);
        const kind = Math.floor(rnd() * 7);
        if (kind === 0) ops.push(issue(pick([asProd, asProdB]), pick([y, z]), a, 1, { order: o, sub: x }));
        else if (kind === 1) ops.push(issue(pick([asProd, asProdB]), pick([y, z]), a, 1, { order: o }));
        else if (kind === 2) ops.push(issue(pick([asProd, asAdmin]), x, a, 1, { order: o }));
        else if (kind === 3) ops.push(asBiuro.rpc("reserve_for_order", { p_client_request_id: randomUUID(), p_order_id: o, p_items: null }));
        else if (kind === 4) ops.push(pick([asBiuro, asBiuroB]).rpc("release_reservation_excess", { p_client_request_id: randomUUID(), p_order_id: o }));
        else if (kind === 5) ops.push(pick([asBiuro, asBiuroB]).from("production_orders").update({ status: pick(["DONE", "OPEN", "IN_PRODUCTION"]) }).eq("id", o));
        else ops.push(substitute(pick([asBiuro, asBiuroB]), lists.get(o)!, x, pick([y, z])));
      }
      const results = await Promise.all(ops);
      for (const r of results) if (r.error) codes.push(r.error.hint ?? r.error.code ?? "?");
      // Po rundzie: aktualne listy ACTIVE (Podmień tworzy nowe) — kolejne Podmień na najnowszej liście z X.
      for (const o of orders) {
        const act = await admin.from("requirements").select("id, created_at, requirement_items(material_id, quantity)").eq("production_order_id", o).eq("status", "ACTIVE").order("created_at", { ascending: false });
        const withX = (act.data ?? []).find((l) => (l.requirement_items as { material_id: string }[]).some((i) => i.material_id === x));
        if (withX) lists.set(o, withX.id as string);
      }
    }
    expect(codes).not.toContain("40P01");
    const allowed = new Set([
      "INSUFFICIENT_STOCK",
      "RESERVED_STOCK",
      "ORDER_NOT_OPEN",
      "NOTHING_TO_RELEASE",
      "ALREADY_WITHDRAWN",
      "NOTHING_TO_SUBSTITUTE",
      "NOT_IN_REQUIREMENTS",
    ]);
    expect(codes.filter((c) => !allowed.has(c))).toEqual([]);
    await sumEventsMatches([x, y, z]);
    const closed = await admin.from("production_orders").select("id").in("id", orders).in("status", ["DONE", "CANCELLED"]);
    const closedIds = (closed.data ?? []).map((r) => r.id as string);
    if (closedIds.length > 0) {
      const left = await admin.from("reservations").select("id").in("production_order_id", closedIds).gt("quantity", 0);
      expect(left.data).toEqual([]);
    }
    // Każde zlecenie ma dokładnie jedną listę ACTIVE (Podmień: wycofanie + kopia atomowo).
    for (const o of orders) {
      const act = await admin.from("requirements").select("id").eq("production_order_id", o).eq("status", "ACTIVE");
      expect(act.data).toHaveLength(1);
    }
    await verify([x, y, z]);
  });

  it("zamknięcie zlecenia w trakcie wydania zamiennika (SUBSTITUTE_RELEASE) → czeka, potem AUTO_RELEASE reszty", async () => {
    const x = await material("CL-X");
    const y = await material("CL-Y");
    const a = await location("CL-A");
    await receive(x, a, 5);
    await receive(y, a, 5);
    await pair(x, y);
    const o = await order("CL");
    await requirement(o, [{ material_id: x, quantity: 5 }, { material_id: y, quantity: 1 }]);
    expect((await asBiuro.rpc("reserve_for_order", { p_client_request_id: randomUUID(), p_order_id: o, p_items: null })).error).toBeNull();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let started!: () => void;
    const ready = new Promise<void>((r) => (started = r));
    const txA = sql.begin(async (tx) => {
      await actAs(tx, tProd.id);
      await tx`select public.stock_issue(${randomUUID()}::uuid, ${a}::uuid, ${y}::uuid, 2::numeric, ${o}::uuid, null, null, null, false, null, ${x}::uuid)`;
      started();
      await gate;
    });
    await ready;
    let settled = false;
    const second = Promise.resolve(asBiuro.from("production_orders").update({ status: "DONE" }).eq("id", o)).finally(() => (settled = true));
    try {
      await new Promise((r) => setTimeout(r, 1500));
      expect(settled).toBe(false);
    } finally {
      open();
      await txA;
    }
    expect((await second).error).toBeNull();
    expect([await reserved(o, x), await reserved(o, y)]).toEqual([0, 0]);
    const types = (await events(o)).map((e) => e.type);
    expect(types).toContain("SUBSTITUTE_RELEASE");
    expect(types).toContain("CONSUME");
    expect(types).toContain("AUTO_RELEASE");
    await sumEventsMatches([x, y]);
    await verify([x, y]);
  });

  /** Transakcja A wykonuje `first` i czeka na bramkę; B musi czekać na blokadę A; zwraca wynik B. */
  async function interleave(
    userId: string,
    first: (tx: postgres.TransactionSql) => Promise<unknown>,
    second: () => PromiseLike<{ error: { code?: string; hint?: string } | null; data?: unknown }>,
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
      expect(settled).toBe(false);
    } finally {
      open();
      await txA;
    }
    return b;
  }

  it("M1: Podmień czeka na wydanie zamiennika za XXX (blokada XXX) i liczy podział z jego uwzględnieniem", async () => {
    const x = await material("M1-X");
    const y = await material("M1-Y");
    const a = await location("M1-A");
    await receive(y, a, 20);
    await pair(x, y);
    const o = await order("M1");
    const list = await requirement(o, [{ material_id: x, quantity: 5 }]);
    const r = await interleave(
      tProd.id,
      (tx) => tx`select public.stock_issue(${randomUUID()}::uuid, ${a}::uuid, ${y}::uuid, 2::numeric, ${o}::uuid, null, null, null, false, null, ${x}::uuid)`,
      () => substitute(asBiuro, list, x, y),
    );
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ kept_quantity: 2, moved_quantity: 3 });
    const b = await balance(o);
    expect([b.get(x)?.remaining, b.get(y)?.remaining]).toEqual([0, 3]);
    await verify([x, y]);
  });

  it("M1: wydanie zamiennika czeka na Podmień; po pełnym przeniesieniu XXX → NOT_IN_REQUIREMENTS", async () => {
    const x = await material("M1B-X");
    const y = await material("M1B-Y");
    const a = await location("M1B-A");
    await receive(y, a, 20);
    await pair(x, y);
    const o = await order("M1B");
    const list = await requirement(o, [{ material_id: x, quantity: 5 }]);
    const r = await interleave(
      tBiuro.id,
      (tx) => tx`select public.substitute_requirement_item(${randomUUID()}::uuid, ${list}::uuid, ${x}::uuid, ${y}::uuid, null)`,
      () => issue(asProd, y, a, 1, { order: o, sub: x }),
    );
    expect(r.error?.hint).toBe("NOT_IN_REQUIREMENTS");
    // Zwykłe wydanie YYY zmniejsza teraz pozostało YYY.
    expect(((await issue(asProd, y, a, 1, { order: o })).data as IssueOut).substitute_for).toBeNull();
    expect((await balance(o)).get(y)?.remaining).toBe(4);
    await verify([x, y]);
  });

  it("M1: dwie listy z XXX — Podmień na obu równolegle (+ wydania zamiennika): bez 40P01, spójny bilans", async () => {
    for (let round = 0; round < 3; round++) {
      const x = await material(`M1C-${round}-X`);
      const y = await material(`M1C-${round}-Y`);
      const a = await location(`C${round}A`);
      await receive(y, a, 30);
      await pair(x, y);
      const o = await order(`M1C-${round}`);
      const l1 = await requirement(o, [{ material_id: x, quantity: 4 }], "L1");
      const l2 = await requirement(o, [{ material_id: x, quantity: 4 }], "L2");
      const ops = await Promise.all([
        substitute(asBiuro, l1, x, y),
        issue(asProd, y, a, 2, { order: o, sub: x }),
        substitute(asBiuroB, l2, x, y),
        issue(asProdB, y, a, 1, { order: o, sub: x }),
      ]);
      const codes = ops.filter((r) => r.error).map((r) => r.error?.hint ?? r.error?.code);
      expect(codes).not.toContain("40P01");
      expect(codes.filter((c) => c !== "NOT_IN_REQUIREMENTS" && c !== "NOTHING_TO_SUBSTITUTE")).toEqual([]);
      // Bilans: Σ potrzebne XXX + YYY = 8 (1:1), wydane zamienniki za XXX liczone do XXX, póki XXX jest na liście.
      const act = await admin.from("requirements").select("id, requirement_items(material_id, quantity)").eq("production_order_id", o).eq("status", "ACTIVE");
      expect(act.data).toHaveLength(2);
      const total = (act.data ?? []).flatMap((l) => l.requirement_items as { quantity: number }[]).reduce((sum, i) => sum + Number(i.quantity), 0);
      expect(total).toBe(8);
      const b = await balance(o);
      // Każde udane wydanie zamiennika jest policzone (do XXX — było na aktywnej liście w chwili wydania);
      // nic nie ginie w bilansie. Wydanie po Podmień może przekroczyć resztę XXX na kopii — to jawne
      // nadwydanie (dozwolone jak zwykłe; UI takiego kandydata nie podpowiada), więc nie wymagamy issued ≤ needed.
      const issuedOk = (ops[1].error ? 0 : 2) + (ops[3].error ? 0 : 1);
      expect((b.get(x)?.issued ?? 0) + (b.get(y)?.issued ?? 0)).toBe(issuedOk);
      expect(b.get(y)?.issued ?? 0).toBe(0);
      await verify([x, y]);
    }
  });
});
