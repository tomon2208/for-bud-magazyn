import { randomBytes, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteImportAlias, importRequirement, listImportAliases, resolveImportCodes, upsertImportAlias } from "@/server/import";
import { createRequirement, listRequirements } from "@/server/requirements";
import { adminClient, createTestUser, deleteAllTestUsers, signIn, type TestUser } from "./helpers";

// Etap 12a (ADR 016): bar_length_m, powiązania kodów (import_code_aliases), resolve_import_codes, import_requirement
// (do istniejącego zlecenia i z nowym zleceniem — atomowo), create_requirement po refaktorze na wspólny rdzeń.
// Dane: materiały is_test (klucz secret) z prefiksem TEST-<runId>-; sprzątanie przez purge_test_stock po usunięciu
// list i powiązań (service_role). Nie dotyka kont admin/user — używa kont test-*.

const admin = adminClient();
const RUN = randomBytes(4).toString("hex").toUpperCase();
const P = `TEST-${RUN}`;

let tAdmin: TestUser;
let tBiuro: TestUser;
let tProd: TestUser;
let asAdmin: SupabaseClient;
let asBiuro: SupabaseClient;
let asProd: SupabaseClient;

let categoryId = "";
const testMaterials: string[] = [];
const testOrders: string[] = [];

async function material(code: string, unit = "szt.", extra: Record<string, unknown> = {}) {
  const { data, error } = await admin
    .from("materials")
    .insert({ code: `${P}-${code}`, name: `Materiał ${code}`, unit, category_id: categoryId, is_test: true, ...extra })
    .select("id")
    .single();
  if (error) throw error;
  testMaterials.push(data.id as string);
  return data.id as string;
}

async function order(name: string, extra: Record<string, unknown> = {}) {
  const { data, error } = await asBiuro.from("production_orders").insert({ name: `${P}-${name}`, ...extra }).select("id").single();
  if (error) throw error;
  testOrders.push(data.id as string);
  return data.id as string;
}

type Item = { material_id: string; quantity: number; note?: string | null; raw_source_ref?: string | null };
const importRpc = (
  client: SupabaseClient,
  args: { orderId?: string | null; newOrder?: { name: string; number?: string | null } | null; name?: string; file?: string; items: Item[]; id?: string },
) =>
  client.rpc("import_requirement", {
    p_order_id: args.orderId ?? null,
    p_new_order: args.newOrder ?? null,
    p_name: args.name ?? "Import",
    p_file_name: args.file ?? "lista.xls",
    p_import_format: "liczokno-lista-materialowa",
    p_items: args.items,
    p_client_request_id: args.id ?? randomUUID(),
  });

const hintOf = (e: { hint?: string | null } | null) => e?.hint ?? null;

let mSzt = "";
let mBar = "";
let mMb = "";
let mInactive = "";

beforeAll(async () => {
  await deleteAllTestUsers(admin);
  tAdmin = await createTestUser(admin, "ADMIN");
  tBiuro = await createTestUser(admin, "BIURO");
  tProd = await createTestUser(admin, "PRODUKCJA");
  [asAdmin, asBiuro, asProd] = await Promise.all([signIn(tAdmin), signIn(tBiuro), signIn(tProd)]);

  const cat = await asAdmin.from("material_categories").insert({ name: `${P}-kat` }).select("id").single();
  if (cat.error) throw cat.error;
  categoryId = cat.data.id;
  mSzt = await material("A115", "szt.");
  mBar = await material("P2102 30/10/AR-RAL7016-FS", "szt.", { bar_length_m: 6.5 });
  mMb = await material("H208", "mb");
  mInactive = await material("OLD1", "szt.");
  const off = await admin.from("materials").update({ active: false }).eq("id", mInactive);
  if (off.error) throw off.error;
});

afterAll(async () => {
  try {
    await admin.from("import_code_aliases").delete().like("source_code", `${P}-%`);
    if (testOrders.length > 0) {
      const del = await admin.from("requirements").delete().in("production_order_id", testOrders);
      if (del.error) console.warn("requirements delete:", del.error.message);
    }
    const purge = await admin.rpc("purge_test_stock", { p_material_ids: testMaterials });
    if (purge.error) console.warn("purge_test_stock:", purge.error.message);
    await admin.from("production_orders").delete().like("name", `${P}-%`);
    await admin.from("materials").delete().like("code", `${P}-%`);
    await admin.from("material_categories").delete().like("name", `${P}-%`);
  } finally {
    await deleteAllTestUsers(admin);
  }
});

// ---------------------------------------------------------------------------
describe("długość sztangi (materials.bar_length_m)", () => {
  it("zakres (0, 20]; ADMIN ustawia, BIURO nie (42501)", async () => {
    for (const bad of [0, -1, 20.001, 21]) {
      const r = await admin.from("materials").update({ bar_length_m: bad }).eq("id", mBar);
      expect(r.error?.code, String(bad)).toMatch(/^(23514|22003)$/);
    }
    const ok = await asAdmin.from("materials").update({ bar_length_m: 6 }).eq("id", mBar).select("bar_length_m").single();
    expect(ok.error).toBeNull();
    expect(Number(ok.data?.bar_length_m)).toBe(6);
    const biuro = await asBiuro.from("materials").update({ bar_length_m: 7 }).eq("id", mBar).select("id");
    expect(biuro.error?.code === "42501" || biuro.data?.length === 0).toBe(true);
    await admin.from("materials").update({ bar_length_m: 6.5 }).eq("id", mBar);
  });
});

describe("uprawnienia", () => {
  it("PRODUKCJA: resolve / zapis / usunięcie powiązań / import → 42501; odczyt tabeli bez wierszy", async () => {
    expect((await asProd.rpc("resolve_import_codes", { p_codes: [`${P}-A115`] })).error?.code).toBe("42501");
    expect((await asProd.rpc("upsert_import_alias", { p_source_code: `${P}-X1`, p_action: "IGNORE" })).error?.code).toBe("42501");
    expect((await asProd.rpc("delete_import_alias", { p_id: randomUUID() })).error?.code).toBe("42501");
    expect((await importRpc(asProd, { newOrder: { name: `${P}-prod` }, items: [{ material_id: mSzt, quantity: 1 }] })).error?.code).toBe("42501");
    const select = await asProd.from("import_code_aliases").select("id");
    expect(select.error === null ? select.data : []).toEqual([]);
  });

  it("zapis do import_code_aliases bezpośrednio (INSERT/UPDATE/DELETE) jest niedozwolony nawet dla ADMIN-a", async () => {
    const ins = await asAdmin.from("import_code_aliases").insert({ source_code: `${P}-DIRECT`, action: "IGNORE" });
    expect(ins.error?.code).toBe("42501");
  });
});

describe("resolve_import_codes", () => {
  it("normalizacja kodu, statusy MATERIAL / UNKNOWN, nieaktywny z active=false, distinct", async () => {
    const r = await resolveImportCodes(asBiuro, {
      codes: [` ${P.toLowerCase()}-a115 `, `${P}-A115`, `${P.toLowerCase()}-p2102  30/10/ar-ral7016-fs`, `${P}-NIEZNANY`, `${P}-OLD1`],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const by = new Map(r.data.map((x) => [x.code, x]));
    expect(by.size).toBe(4);
    expect(by.get(`${P}-A115`)).toMatchObject({ status: "MATERIAL", material: { unit: "szt.", allowsFraction: false, barLengthM: null, active: true } });
    expect(by.get(`${P}-P2102 30/10/AR-RAL7016-FS`)).toMatchObject({ status: "MATERIAL", material: { barLengthM: 6.5 } });
    expect(by.get(`${P}-NIEZNANY`)).toMatchObject({ status: "UNKNOWN", material: null });
    expect(by.get(`${P}-OLD1`)?.material?.active).toBe(false);
  });

  it("limit 1000 kodów → 400 VALIDATION; PRODUKCJA → 403", async () => {
    const many = await asBiuro.rpc("resolve_import_codes", { p_codes: Array.from({ length: 1001 }, (_, i) => `${P}-K${i}`) });
    expect(hintOf(many.error)).toBe("VALIDATION");
    const prod = await resolveImportCodes(asProd, { codes: [`${P}-A115`] });
    expect(prod.ok ? null : prod.error.status).toBe(403);
  });
});

describe("powiązania kodów (MAP / IGNORE)", () => {
  it("MAP ma pierwszeństwo przed kodem materiału; IGNORE → IGNORED; upsert po kodzie; audyt", async () => {
    const code = `${P}-A115`; // istnieje jako kod materiału mSzt
    const map = await upsertImportAlias(asBiuro, { source_code: code.toLowerCase(), action: "MAP", material_id: mMb });
    expect(map.ok && map.data).toMatchObject({ sourceCode: code, action: "MAP", materialId: mMb });
    let res = await resolveImportCodes(asBiuro, { codes: [code] });
    expect(res.ok && res.data[0]).toMatchObject({ status: "ALIAS_MAP", material: { id: mMb } });
    expect(res.ok && res.data[0].aliasId).toBeTruthy();

    const ign = await upsertImportAlias(asAdmin, { source_code: code, action: "IGNORE", material_id: null });
    expect(ign.ok && ign.data).toMatchObject({ action: "IGNORE", materialId: null });
    res = await resolveImportCodes(asBiuro, { codes: [code] });
    expect(res.ok && res.data[0].status).toBe("IGNORED");

    const list = await listImportAliases(asBiuro);
    const mine = list.ok ? list.data.items.filter((a) => a.sourceCode === code) : [];
    expect(mine).toHaveLength(1);
    expect(mine[0].action).toBe("IGNORE");
    const audit = await admin.from("import_code_aliases").select("created_by, updated_by").eq("source_code", code).single();
    expect(audit.data).toMatchObject({ created_by: tBiuro.id, updated_by: tAdmin.id });

    // usunięcie przywraca dopasowanie po kodzie materiału
    expect((await deleteImportAlias(asBiuro, mine[0].id)).ok).toBe(true);
    res = await resolveImportCodes(asBiuro, { codes: [code] });
    expect(res.ok && res.data[0]).toMatchObject({ status: "MATERIAL", material: { id: mSzt } });
    const again = await deleteImportAlias(asBiuro, mine[0].id);
    expect(again.ok ? null : again.error).toMatchObject({ status: 404 });
  });

  it("walidacje: MAP bez materiału, IGNORE z materiałem, nieaktywny, nieistniejący, zły kod, zła akcja", async () => {
    const call = (action: string, material: string | null, code = `${P}-V1`) =>
      asBiuro.rpc("upsert_import_alias", { p_source_code: code, p_action: action, p_material_id: material });
    expect(hintOf((await call("MAP", null)).error)).toBe("VALIDATION");
    expect(hintOf((await call("IGNORE", mSzt)).error)).toBe("VALIDATION");
    expect(hintOf((await call("MAP", mInactive)).error)).toBe("MATERIAL_INACTIVE");
    expect(hintOf((await call("MAP", randomUUID())).error)).toBe("NOT_FOUND");
    expect(hintOf((await call("IGNORE", null, "Ą(1)")).error)).toBe("INVALID_CODE");
    expect(hintOf((await call("FOO", null)).error)).toBe("VALIDATION");
    const svc = await upsertImportAlias(asBiuro, { source_code: `${P}-V1`, action: "MAP", material_id: mInactive });
    expect(svc.ok ? null : svc.error).toMatchObject({ status: 400, code: "MATERIAL_INACTIVE" });
  });

  // service_role ma tylko SELECT + DELETE (sprzątanie) — bezpośredni zapis odrzucony uprawnieniami,
  // zanim zadziała CHECK (MAP ⇔ material_id); CHECK sprawdzony na PGlite i przez walidację upsert_import_alias.
  it("bezpośredni INSERT kluczem secret odrzucony (brak uprawnień zapisu)", async () => {
    const a = await admin.from("import_code_aliases").insert({ source_code: `${P}-C1`, action: "MAP" });
    expect(a.error?.code).toBe("42501");
    const b = await admin.from("import_code_aliases").insert({ source_code: `${P}-C2`, action: "IGNORE", material_id: mSzt });
    expect(b.error?.code).toBe("42501");
  });
});

describe("import_requirement — istniejące zlecenie", () => {
  it("tworzy listę IMPORT z raw_source_ref, plikiem i formatem; replay; konflikty", async () => {
    const orderId = await order("I1");
    const id = randomUUID();
    const items: Item[] = [
      { material_id: mSzt, quantity: 4, raw_source_ref: "LiczOkno: A115 w. 4: 4 szt." },
      { material_id: mBar, quantity: 7, raw_source_ref: "LiczOkno: P2102 w. 1, 2: 44,2 m" },
    ];
    const first = await importRpc(asBiuro, { orderId, items, id });
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({ order_id: orderId, item_count: 2, order_created: false, idempotent_replay: false });
    const reqId = (first.data as { requirement_id: string }).requirement_id;

    const listed = await listRequirements(asBiuro, orderId);
    expect(listed.ok && listed.data[0]).toMatchObject({ id: reqId, source: "IMPORT", importedFileName: "lista.xls", importFormat: "liczokno-lista-materialowa", status: "ACTIVE" });
    const refs = await admin.from("requirement_items").select("raw_source_ref, quantity").eq("requirement_id", reqId).order("quantity");
    expect(refs.data?.map((r) => r.raw_source_ref)).toEqual(["LiczOkno: A115 w. 4: 4 szt.", "LiczOkno: P2102 w. 1, 2: 44,2 m"]);

    const replay = await importRpc(asBiuro, { orderId, items, id });
    expect(replay.data).toMatchObject({ requirement_id: reqId, idempotent_replay: true });

    expect(hintOf((await importRpc(asBiuro, { orderId, items: [{ ...items[0], quantity: 5 }, items[1]], id })).error)).toBe("IDEMPOTENCY_CONFLICT");
    expect(hintOf((await importRpc(asBiuro, { orderId, items, id, file: "inny.xls" })).error)).toBe("IDEMPOTENCY_CONFLICT");
    expect(hintOf((await importRpc(asBiuro, { orderId, items: [{ ...items[0], raw_source_ref: "inna" }, items[1]], id })).error)).toBe("IDEMPOTENCY_CONFLICT");
    expect(hintOf((await importRpc(asAdmin, { orderId, items, id })).error)).toBe("IDEMPOTENCY_CONFLICT");

    // serwis (API)
    const svc = await importRequirement(asBiuro, { order_id: orderId, name: "Serwis", file_name: "x.xls", import_format: "f", items: [{ material_id: mMb, quantity: 2.5, raw_source_ref: null }], client_request_id: randomUUID() });
    expect(svc.ok && svc.data).toMatchObject({ orderId, orderCreated: false, idempotentReplay: false, itemCount: 1 });
  });

  it("walidacje jak w create_requirement: duplikat, ilość, ułamek, nieaktywny, brak materiału/zlecenia, zlecenie zamknięte", async () => {
    const orderId = await order("I2");
    const rpc = (items: Item[], extra: { orderId?: string; name?: string } = {}) => importRpc(asBiuro, { orderId: extra.orderId ?? orderId, items, name: extra.name });
    expect(hintOf((await rpc([{ material_id: mSzt, quantity: 1 }, { material_id: mSzt, quantity: 2 }])).error)).toBe("DUPLICATE_MATERIAL");
    expect(hintOf((await rpc([{ material_id: mSzt, quantity: 0 }])).error)).toBe("INVALID_QUANTITY");
    const frac = await rpc([{ material_id: mSzt, quantity: 1.5 }]);
    expect(hintOf(frac.error)).toBe("NOT_INTEGER");
    expect(frac.error?.details).toBe(`${P}-A115`);
    expect(hintOf((await rpc([{ material_id: mInactive, quantity: 1 }])).error)).toBe("MATERIAL_INACTIVE");
    expect(hintOf((await rpc([{ material_id: randomUUID(), quantity: 1 }])).error)).toBe("NOT_FOUND");
    expect(hintOf((await rpc([])).error)).toBe("VALIDATION");
    expect(hintOf((await rpc([{ material_id: mMb, quantity: 1, raw_source_ref: "x".repeat(201) }])).error)).toBe("VALIDATION");
    expect(hintOf((await rpc([{ material_id: mMb, quantity: 1 }], { name: " " })).error)).toBe("VALIDATION");
    expect(hintOf((await rpc([{ material_id: mMb, quantity: 1 }], { orderId: randomUUID() })).error)).toBe("NOT_FOUND");
    expect(hintOf((await importRpc(asBiuro, { items: [{ material_id: mMb, quantity: 1 }] })).error)).toBe("VALIDATION"); // ani zlecenia, ani nowego
    expect(hintOf((await importRpc(asBiuro, { orderId, newOrder: { name: `${P}-N` }, items: [{ material_id: mMb, quantity: 1 }] })).error)).toBe("VALIDATION"); // oba

    await asBiuro.from("production_orders").update({ status: "DONE" }).eq("id", orderId);
    expect(hintOf((await rpc([{ material_id: mMb, quantity: 1 }])).error)).toBe("ORDER_NOT_OPEN");
  });
});

describe("import_requirement — nowe zlecenie (atomowo)", () => {
  async function ordersCount() {
    const r = await admin.from("production_orders").select("id", { count: "exact", head: true }).like("name", `${P}-%`);
    return r.count ?? 0;
  }

  it("tworzy zlecenie (nazwa, numer, OPEN, audyt) i listę; replay nie dubluje zlecenia; konflikt przy innych danych", async () => {
    const before = await ordersCount();
    const id = randomUUID();
    const items: Item[] = [{ material_id: mMb, quantity: 9.64, raw_source_ref: "r" }];
    const newOrder = { name: `  ${P}-Nowe `, number: ` ${P}-NR1 ` };
    const first = await importRpc(asBiuro, { newOrder, items, id });
    expect(first.error).toBeNull();
    const out = first.data as { order_id: string; requirement_id: string; order_created: boolean; idempotent_replay: boolean };
    expect(out).toMatchObject({ order_created: true, idempotent_replay: false });
    testOrders.push(out.order_id);

    const o = await admin.from("production_orders").select("name, number, status, created_by").eq("id", out.order_id).single();
    expect(o.data).toMatchObject({ name: `${P}-Nowe`, number: `${P}-NR1`, status: "OPEN", created_by: tBiuro.id });
    const reqs = await admin.from("requirements").select("id, source, status").eq("production_order_id", out.order_id);
    expect(reqs.data).toEqual([{ id: out.requirement_id, source: "IMPORT", status: "ACTIVE" }]);

    const replay = await importRpc(asBiuro, { newOrder, items, id });
    expect(replay.data).toMatchObject({ order_id: out.order_id, requirement_id: out.requirement_id, idempotent_replay: true });
    expect(await ordersCount()).toBe(before + 1);
    expect(hintOf((await importRpc(asBiuro, { newOrder: { ...newOrder, name: `${P}-Inne` }, items, id })).error)).toBe("IDEMPOTENCY_CONFLICT");

    // serwis: nazwa/numer z formularza
    const svc = await importRequirement(asBiuro, {
      new_order: { name: `${P}-Serwis`, number: null },
      name: "L",
      file_name: "f.xls",
      import_format: "liczokno-lista-materialowa",
      items: [{ material_id: mMb, quantity: 1 }],
      client_request_id: randomUUID(),
    });
    expect(svc.ok && svc.data.orderCreated).toBe(true);
    if (svc.ok) testOrders.push(svc.data.orderId);
  });

  it("NUMBER_TAKEN (bez względu na wielkość liter) — bez nowego zlecenia i listy", async () => {
    const existing = await order("NT1", { number: `${P}-NR-TAKEN` });
    void existing;
    const before = await ordersCount();
    const r = await importRpc(asBiuro, { newOrder: { name: `${P}-NT2`, number: `${P.toLowerCase()}-nr-taken` }, items: [{ material_id: mMb, quantity: 1 }] });
    expect(hintOf(r.error)).toBe("NUMBER_TAKEN");
    expect(await ordersCount()).toBe(before);
    const svc = await importRequirement(asBiuro, {
      new_order: { name: `${P}-NT3`, number: `${P}-NR-TAKEN` },
      name: "L",
      file_name: "f.xls",
      import_format: "f",
      items: [{ material_id: mMb, quantity: 1 }],
      client_request_id: randomUUID(),
    });
    expect(svc.ok ? null : svc.error).toMatchObject({ status: 409, code: "NUMBER_TAKEN" });
  });

  it("atomowość: błąd pozycji cofa także zlecenie", async () => {
    const before = await ordersCount();
    const a = await importRpc(asBiuro, { newOrder: { name: `${P}-ATOM1`, number: `${P}-ATOM1` }, items: [{ material_id: mSzt, quantity: 1.5 }] });
    expect(hintOf(a.error)).toBe("NOT_INTEGER");
    const b = await importRpc(asBiuro, { newOrder: { name: `${P}-ATOM2` }, items: [{ material_id: mInactive, quantity: 1 }] });
    expect(hintOf(b.error)).toBe("MATERIAL_INACTIVE");
    const c = await importRpc(asBiuro, { newOrder: { name: `${P}-ATOM3` }, items: [{ material_id: mMb, quantity: 1 }, { material_id: mMb, quantity: 2 }] });
    expect(hintOf(c.error)).toBe("DUPLICATE_MATERIAL");
    expect(await ordersCount()).toBe(before);
  });

  it("walidacja nowego zlecenia: pusta nazwa, numer > 50, obce pole", async () => {
    const items = [{ material_id: mMb, quantity: 1 }];
    expect(hintOf((await importRpc(asBiuro, { newOrder: { name: "  " }, items })).error)).toBe("VALIDATION");
    expect(hintOf((await importRpc(asBiuro, { newOrder: { name: `${P}-V`, number: "n".repeat(51) }, items })).error)).toBe("VALIDATION");
    expect(hintOf((await importRpc(asBiuro, { newOrder: { name: `${P}-V`, foo: 1 } as never, items })).error)).toBe("VALIDATION");
    // typy pól: name nie-tekst, brak name, number nie-tekst
    for (const bad of [{ name: 5 }, { name: null }, {}, { name: `${P}-V`, number: 5 }, { name: `${P}-V`, number: true }]) {
      expect(hintOf((await importRpc(asBiuro, { newOrder: bad as never, items })).error), JSON.stringify(bad)).toBe("VALIDATION");
    }
    // number: null i brak pola są poprawne
    const okNull = await importRpc(asBiuro, { newOrder: { name: `${P}-VN`, number: null }, items });
    expect(okNull.error).toBeNull();
    testOrders.push((okNull.data as { order_id: string }).order_id);
  });
});

describe("create_requirement po refaktorze na wspólny rdzeń", () => {
  it("zachowuje sygnaturę i odpowiedź (bez order_id), źródło MANUAL, replay i konflikt, role", async () => {
    const orderId = await order("CR1");
    const id = randomUUID();
    const items = [{ material_id: mMb, quantity: 2.5, note: " n " }, { material_id: mSzt, quantity: 3 }];
    const first = await asBiuro.rpc("create_requirement", { p_order_id: orderId, p_name: " Ręczna ", p_items: items, p_client_request_id: id });
    expect(first.error).toBeNull();
    expect(first.data).toEqual({ requirement_id: expect.any(String), item_count: 2, idempotent_replay: false });
    const reqId = (first.data as { requirement_id: string }).requirement_id;
    const row = await admin.from("requirements").select("source, name, imported_file_name, import_format").eq("id", reqId).single();
    expect(row.data).toEqual({ source: "MANUAL", name: "Ręczna", imported_file_name: null, import_format: null });
    const stored = await admin.from("requirement_items").select("note, raw_source_ref").eq("requirement_id", reqId).order("quantity");
    expect(stored.data).toEqual([{ note: "n", raw_source_ref: null }, { note: null, raw_source_ref: null }]);

    const replay = await asBiuro.rpc("create_requirement", { p_order_id: orderId, p_name: "Ręczna", p_items: items, p_client_request_id: id });
    expect(replay.data).toMatchObject({ requirement_id: reqId, idempotent_replay: true });
    expect(hintOf((await asBiuro.rpc("create_requirement", { p_order_id: orderId, p_name: "Inna", p_items: items, p_client_request_id: id })).error)).toBe("IDEMPOTENCY_CONFLICT");
    expect((await asProd.rpc("create_requirement", { p_order_id: orderId, p_name: "x", p_items: items })).error?.code).toBe("42501");
    // ten sam identyfikator użyty wcześniej przez import to inna lista (źródło wchodzi do odcisku)
    const viaService = await createRequirement(asBiuro, orderId, { name: "Serwis", items: [{ material_id: mMb, quantity: 1 }], client_request_id: randomUUID() });
    expect(viaService.ok && viaService.data.itemCount).toBe(1);
  });
});
