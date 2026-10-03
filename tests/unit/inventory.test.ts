import { beforeEach, describe, expect, it, vi } from "vitest";
import { addRow, buildCountItems, initialRows } from "@/lib/inventory-count";
import { finishSend, initialAttempt, startSend } from "@/lib/operation-attempt";
import {
  approveSchema,
  cancelSessionSchema,
  createSessionSchema,
  exportInventoryQuerySchema,
  isApprovable,
  overReservationAfterApprove,
  saveCountSchema,
} from "@/lib/validation/inventory";
import type { CountingItemDto } from "@/server/inventory";

// Etap 13 (ADR 015): walidacja zod, logika ekranu liczenia, mechanizm prób (ten sam id przy ponowieniu),
// route handlery inwentaryzacji (401 / 403 / 415 / CSRF / 400 / 201 / 200 / 409) i wariant „na ślepo” dla PRODUKCJI.

const state: { sub: string | null; profile: Record<string, unknown> | null } = { sub: null, profile: null };

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: {
      getClaims: async () => (state.sub ? { data: { claims: { sub: state.sub } }, error: null } : { data: null, error: null }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: state.profile, error: null }) }),
      }),
    }),
  }),
}));

const service = vi.hoisted(() => ({
  listInventorySessions: vi.fn(),
  createInventorySession: vi.fn(),
  getSessionOverview: vi.fn(),
  getSessionReview: vi.fn(),
  getSessionEvents: vi.fn(),
  getCountingLocation: vi.fn(),
  saveLocationCount: vi.fn(),
  approveInventory: vi.fn(),
  closeInventorySession: vi.fn(),
  cancelInventorySession: vi.fn(),
  exportInventoryCsv: vi.fn(),
}));
vi.mock("@/server/inventory", () => service);

const sessionsRoute = await import("@/app/api/v1/inventory/sessions/route");
const sessionRoute = await import("@/app/api/v1/inventory/sessions/[id]/route");
const locationRoute = await import("@/app/api/v1/inventory/sessions/[id]/locations/[locationId]/route");
const countRoute = await import("@/app/api/v1/inventory/sessions/[id]/locations/[locationId]/count/route");
const approveRoute = await import("@/app/api/v1/inventory/sessions/[id]/approve/route");
const closeRoute = await import("@/app/api/v1/inventory/sessions/[id]/close/route");
const cancelRoute = await import("@/app/api/v1/inventory/sessions/[id]/cancel/route");
const exportRoute = await import("@/app/api/v1/inventory/sessions/[id]/export/route");

const BASE = "http://localhost:8787";
const ID = "6f1c1e0a-2b0d-4c3e-9f5a-1b2c3d4e5f60";
const LOC = "7a2d2f1b-3c1e-4d4f-8a6b-2c3d4e5f6071";
const MAT = "8b3e3a2c-4d2f-4e5a-9b7c-3d4e5f607182";
const MAT2 = "9c4f4b3d-5e3a-4f6b-8c8d-4e5f60718293";
const CRID = "0d5a5c4e-6f4b-4a7c-9d9e-5f6071829304";
const STARTED = "2026-10-03T04:25:10.123456+00:00";
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) }) as never;
const lctx = (id = ID, locationId = LOC) => ({ params: Promise.resolve({ id, locationId }) }) as never;
const getRequest = (path: string) => new Request(new URL(path, BASE));
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(new URL(path, BASE), {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, ...headers },
    body: JSON.stringify(body),
  });

function as(role: string | null) {
  if (role === null) {
    state.sub = null;
    state.profile = null;
    return;
  }
  state.sub = "actor-id";
  state.profile = { id: "actor-id", login: "actor", full_name: "Actor", role, active: true };
}

beforeEach(() => {
  as(null);
  for (const fn of Object.values(service)) {
    fn.mockReset().mockResolvedValue({ ok: true, data: { idempotentReplay: false, filename: "inw.csv", body: "Lokalizacja\r\n" } });
  }
});
const serviceCalls = () => Object.values(service).reduce((n, fn) => n + fn.mock.calls.length, 0);

const S = `/api/v1/inventory/sessions/${ID}`;
const validCreate = { client_request_id: CRID, name: "  Regał A ", code_prefix: " a- " };
const validCount = { client_request_id: CRID, started_at: STARTED, location_version: 3, items: [{ material_id: MAT, quantity: "2,5" }, { material_id: MAT2, quantity: 0 }] };

type Case = { name: string; allowed: string[]; call: () => Promise<Response> };
const ALL = ["ADMIN", "BIURO", "PRODUKCJA"];
const cases: Case[] = [
  { name: "GET /inventory/sessions", allowed: ALL, call: () => sessionsRoute.GET(getRequest("/api/v1/inventory/sessions?status=OPEN")) },
  { name: "POST /inventory/sessions", allowed: ["ADMIN", "BIURO"], call: () => sessionsRoute.POST(post("/api/v1/inventory/sessions", validCreate)) },
  { name: "GET /inventory/sessions/[id]", allowed: ALL, call: () => sessionRoute.GET(getRequest(S), ctx()) },
  { name: "GET .../locations/[locationId]", allowed: ["ADMIN", "PRODUKCJA"], call: () => locationRoute.GET(getRequest(`${S}/locations/${LOC}`), lctx()) },
  { name: "POST .../count", allowed: ["ADMIN", "PRODUKCJA"], call: () => countRoute.POST(post(`${S}/locations/${LOC}/count`, validCount), lctx()) },
  { name: "POST .../approve", allowed: ["ADMIN", "BIURO"], call: () => approveRoute.POST(post(`${S}/approve`, { client_request_id: CRID }), ctx()) },
  { name: "POST .../close", allowed: ["ADMIN", "BIURO"], call: () => closeRoute.POST(post(`${S}/close`, { client_request_id: CRID }), ctx()) },
  { name: "POST .../cancel", allowed: ["ADMIN", "BIURO"], call: () => cancelRoute.POST(post(`${S}/cancel`, { client_request_id: CRID }), ctx()) },
  { name: "GET .../export", allowed: ["ADMIN", "BIURO"], call: () => exportRoute.GET(getRequest(`${S}/export?onlyDiff=true`), ctx()) },
];

describe.each(cases)("$name — uprawnienia", ({ allowed, call }) => {
  it("bez sesji → 401", async () => {
    expect((await call()).status).toBe(401);
    expect(serviceCalls()).toBe(0);
  });
  for (const role of ALL) {
    if (allowed.includes(role)) {
      it(`${role} → dozwolone`, async () => {
        as(role);
        expect((await call()).status).toBeLessThan(300);
        expect(serviceCalls()).toBeGreaterThan(0);
      });
    } else {
      it(`${role} → 403`, async () => {
        as(role);
        expect((await call()).status).toBe(403);
        expect(serviceCalls()).toBe(0);
      });
    }
  }
});

describe("GET /inventory/sessions/[id] — liczenie na ślepo", () => {
  it("PRODUKCJA: tylko nagłówek i lokalizacje (bez tabeli ze stanem systemowym i historii)", async () => {
    as("PRODUKCJA");
    service.getSessionOverview.mockResolvedValue({ ok: true, data: { session: { id: ID }, locations: [] } });
    const res = await sessionRoute.GET(getRequest(S), ctx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(Object.keys(body.data).sort()).toEqual(["locations", "session"]);
    expect(service.getSessionReview).not.toHaveBeenCalled();
    expect(service.getSessionEvents).not.toHaveBeenCalled();
  });

  it("BIURO: + wiersze ze stanem systemowym i historia; 404 przenoszone z serwisu", async () => {
    as("BIURO");
    service.getSessionOverview.mockResolvedValue({ ok: true, data: { session: { id: ID }, locations: [] } });
    service.getSessionReview.mockResolvedValue({ ok: true, data: [{ systemQuantity: 5 }] });
    service.getSessionEvents.mockResolvedValue({ ok: true, data: [] });
    const body = (await (await sessionRoute.GET(getRequest(S), ctx())).json()) as { data: Record<string, unknown> };
    expect(Object.keys(body.data).sort()).toEqual(["events", "locations", "rows", "session"]);
    service.getSessionOverview.mockResolvedValue({ ok: false, error: { status: 404, code: "NOT_FOUND", message: "x" } });
    expect((await sessionRoute.GET(getRequest(S), ctx())).status).toBe(404);
    expect((await sessionRoute.GET(getRequest("/api/v1/inventory/sessions/x"), ctx("x"))).status).toBe(400);
  });
});

describe("POST /inventory/sessions", () => {
  beforeEach(() => as("BIURO"));

  it("201; nazwa przycięta, prefiks wielkimi literami; replay → 200; 409 z serwisu", async () => {
    service.createInventorySession.mockResolvedValue({ ok: true, data: { sessionId: ID, idempotentReplay: false } });
    expect((await sessionsRoute.POST(post("/api/v1/inventory/sessions", validCreate))).status).toBe(201);
    expect(service.createInventorySession).toHaveBeenCalledWith(expect.anything(), { client_request_id: CRID, name: "Regał A", code_prefix: "A-" });
    service.createInventorySession.mockResolvedValue({ ok: true, data: { sessionId: ID, idempotentReplay: true } });
    expect((await sessionsRoute.POST(post("/api/v1/inventory/sessions", validCreate))).status).toBe(200);
    service.createInventorySession.mockResolvedValue({ ok: false, error: { status: 409, code: "LOCATION_IN_OPEN_SESSION", message: "x", details: { locations: "A-1" } } });
    const res = await sessionsRoute.POST(post("/api/v1/inventory/sessions", validCreate));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { details: unknown } }).error.details).toEqual({ locations: "A-1" });
  });

  it.each([
    ["brak sposobu wyboru", { client_request_id: CRID, name: "a" }],
    ["dwa sposoby", { client_request_id: CRID, name: "a", code_prefix: "A", all_locations: true }],
    ["pusta lista", { client_request_id: CRID, name: "a", location_ids: [] }],
    ["zły identyfikator lokalizacji", { client_request_id: CRID, name: "a", location_ids: ["x"] }],
    ["all_locations false", { client_request_id: CRID, name: "a", all_locations: false }],
    ["pusta nazwa", { client_request_id: CRID, name: "  ", all_locations: true }],
    ["za długa nazwa", { client_request_id: CRID, name: "x".repeat(121), all_locations: true }],
    ["brak id żądania", { name: "a", all_locations: true }],
    ["nieznane pole", { ...validCreate, status: "CLOSED" }],
  ])("%s → 400", async (_n, body) => {
    expect((await sessionsRoute.POST(post("/api/v1/inventory/sessions", body))).status).toBe(400);
    expect(serviceCalls()).toBe(0);
  });

  it("CSRF: text/plain → 415, obcy Origin → 403", async () => {
    expect((await sessionsRoute.POST(post("/api/v1/inventory/sessions", validCreate, { "content-type": "text/plain" }))).status).toBe(415);
    expect((await sessionsRoute.POST(post("/api/v1/inventory/sessions", validCreate, { origin: "https://evil.example" }))).status).toBe(403);
    expect(serviceCalls()).toBe(0);
  });

  it("GET: zły status → 400", async () => {
    expect((await sessionsRoute.GET(getRequest("/api/v1/inventory/sessions?status=DONE"))).status).toBe(400);
  });
});

describe("POST .../count", () => {
  beforeEach(() => as("PRODUKCJA"));
  const path = `${S}/locations/${LOC}/count`;

  it("201; ilość z przecinkiem → liczba, 0 dozwolone; id sesji i lokalizacji z URL", async () => {
    expect((await countRoute.POST(post(path, validCount), lctx())).status).toBe(201);
    expect(service.saveLocationCount).toHaveBeenCalledWith(expect.anything(), ID, LOC, {
      client_request_id: CRID,
      started_at: STARTED,
      location_version: 3,
      items: [{ material_id: MAT, quantity: 2.5 }, { material_id: MAT2, quantity: 0 }],
    });
    service.saveLocationCount.mockResolvedValue({ ok: true, data: { idempotentReplay: true } });
    expect((await countRoute.POST(post(path, validCount), lctx())).status).toBe(200);
  });

  it("pusta lista pozycji dozwolona (lokalizacja pusta)", async () => {
    expect((await countRoute.POST(post(path, { ...validCount, items: [] }), lctx())).status).toBe(201);
  });

  it.each([
    ["ilość ujemna", { ...validCount, items: [{ material_id: MAT, quantity: "-1" }] }],
    ["4 miejsca po przecinku", { ...validCount, items: [{ material_id: MAT, quantity: "1,0001" }] }],
    ["duplikat materiału", { ...validCount, items: [{ material_id: MAT, quantity: 1 }, { material_id: MAT, quantity: 2 }] }],
    ["brak czasu rozpoczęcia", { client_request_id: CRID, location_version: 0, items: [] }],
    ["brak wersji lokalizacji", { client_request_id: CRID, started_at: STARTED, items: [] }],
    ["ujemna wersja", { ...validCount, location_version: -1 }],
    ["wersja ułamkowa", { ...validCount, location_version: 1.5 }],
    ["zły czas", { ...validCount, started_at: "wczoraj" }],
    ["nieznane pole pozycji", { ...validCount, items: [{ material_id: MAT, quantity: 1, system: 5 }] }],
    ["501 pozycji", { ...validCount, items: Array.from({ length: 501 }, (_, i) => ({ material_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, quantity: 1 })) }],
  ])("%s → 400", async (_n, body) => {
    expect((await countRoute.POST(post(path, body), lctx())).status).toBe(400);
    expect(serviceCalls()).toBe(0);
  });

  it("zły identyfikator lokalizacji → 400; CSRF; 409 ALREADY_APPROVED z serwisu", async () => {
    expect((await countRoute.POST(post(`${S}/locations/x/count`, validCount), lctx(ID, "x"))).status).toBe(400);
    expect((await countRoute.POST(post(path, validCount, { origin: "https://evil.example" }), lctx())).status).toBe(403);
    expect(serviceCalls()).toBe(0);
    service.saveLocationCount.mockResolvedValue({ ok: false, error: { status: 409, code: "ALREADY_APPROVED", message: "x" } });
    expect((await countRoute.POST(post(path, validCount), lctx())).status).toBe(409);
  });
});

describe("POST .../approve, close, cancel; GET export", () => {
  beforeEach(() => as("BIURO"));

  it("approve: count_ids przekazane; puste/zbyt wiele/zły id → 400; 409 SESSION_NOT_OPEN", async () => {
    expect((await approveRoute.POST(post(`${S}/approve`, { client_request_id: CRID, count_ids: [MAT] }), ctx())).status).toBe(201);
    expect(service.approveInventory).toHaveBeenCalledWith(expect.anything(), ID, { client_request_id: CRID, count_ids: [MAT] });
    for (const body of [
      { client_request_id: CRID, count_ids: [] },
      { client_request_id: CRID, count_ids: ["x"] },
      { client_request_id: CRID, count_ids: Array.from({ length: 5001 }, () => MAT) },
      { client_request_id: CRID, all: true },
      {},
    ]) {
      expect((await approveRoute.POST(post(`${S}/approve`, body), ctx())).status).toBe(400);
    }
    service.approveInventory.mockResolvedValue({ ok: false, error: { status: 409, code: "SESSION_NOT_OPEN", message: "x" } });
    expect((await approveRoute.POST(post(`${S}/approve`, { client_request_id: CRID }), ctx())).status).toBe(409);
  });

  it("cancel: powód przycięty (pusty → null), > 200 znaków → 400; close: 409 z serwisu", async () => {
    expect((await cancelRoute.POST(post(`${S}/cancel`, { client_request_id: CRID, reason: "  " }), ctx())).status).toBe(200);
    expect(service.cancelInventorySession).toHaveBeenCalledWith(expect.anything(), ID, { client_request_id: CRID, reason: null });
    expect((await cancelRoute.POST(post(`${S}/cancel`, { client_request_id: CRID, reason: "x".repeat(201) }), ctx())).status).toBe(400);
    service.closeInventorySession.mockResolvedValue({ ok: false, error: { status: 409, code: "SESSION_NOT_OPEN", message: "x" } });
    expect((await closeRoute.POST(post(`${S}/close`, { client_request_id: CRID }), ctx())).status).toBe(409);
    expect((await closeRoute.POST(post(`${S}/close`, { client_request_id: CRID, force: true }), ctx())).status).toBe(400);
  });

  it("export: CSV z BOM i nazwą pliku; onlyDiff przekazany; zły parametr → 400", async () => {
    service.exportInventoryCsv.mockResolvedValue({ ok: true, data: { filename: "inwentaryzacja-roznice_x.csv", body: "Lokalizacja\r\n" } });
    const res = await exportRoute.GET(getRequest(`${S}/export?onlyDiff=true`), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("inwentaryzacja-roznice_x.csv");
    expect([...new Uint8Array(await res.arrayBuffer()).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(service.exportInventoryCsv).toHaveBeenCalledWith(expect.anything(), ID, true);
    expect((await exportRoute.GET(getRequest(`${S}/export?onlyDiff=tak`), ctx())).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe("walidacja zod", () => {
  it("createSessionSchema: dokładnie jeden sposób wyboru lokalizacji", () => {
    expect(createSessionSchema.safeParse({ client_request_id: CRID, name: "a", all_locations: true }).success).toBe(true);
    expect(createSessionSchema.safeParse({ client_request_id: CRID, name: "a", location_ids: [LOC] }).success).toBe(true);
    expect(createSessionSchema.safeParse({ client_request_id: CRID, name: "a", location_ids: [LOC], code_prefix: "A" }).success).toBe(false);
    const p = createSessionSchema.safeParse({ client_request_id: CRID, name: "a", code_prefix: " b-1 ", note: " " });
    expect(p.success && p.data).toMatchObject({ code_prefix: "B-1", note: null });
  });

  it("saveCountSchema: czas serwera z mikrosekundami i strefą, 0 i przecinek", () => {
    const p = saveCountSchema.safeParse({ ...validCount, items: [{ material_id: MAT, quantity: "0" }] });
    expect(p.success && p.data.items[0].quantity).toBe(0);
    expect(saveCountSchema.safeParse({ ...validCount, started_at: "2026-10-03T04:25:10Z" }).success).toBe(true);
    expect(saveCountSchema.safeParse({ ...validCount, items: [{ material_id: MAT, quantity: "1.500" }] }).success).toBe(false);
  });

  it("approveSchema / cancelSessionSchema / exportInventoryQuerySchema", () => {
    expect(approveSchema.safeParse({ client_request_id: CRID, count_ids: null }).success).toBe(true);
    expect(approveSchema.safeParse({ client_request_id: CRID, count_ids: [MAT], expected_counts: { [MAT]: 2.5 } }).success).toBe(true);
    expect(approveSchema.safeParse({ client_request_id: CRID, expected_counts: { x: 1 } }).success).toBe(false);
    expect(approveSchema.safeParse({ client_request_id: CRID, expected_counts: { [MAT]: -1 } }).success).toBe(false);
    expect(approveSchema.safeParse({ client_request_id: CRID, expected_counts: { [MAT]: "2" } }).success).toBe(false);
    expect(cancelSessionSchema.safeParse({ client_request_id: CRID }).success).toBe(true);
    expect(exportInventoryQuerySchema.parse({ onlyDiff: "false" })).toEqual({ onlyDiff: false });
    expect(exportInventoryQuerySchema.parse({})).toEqual({});
  });
});

describe("tabela zatwierdzania: isApprovable i ostrzeżenie o nadrezerwacji", () => {
  it("do zatwierdzenia: DIFF/OK bez blokady i z pozycją liczenia", () => {
    expect(isApprovable({ countId: "c", status: "DIFF", blockedReason: null })).toBe(true);
    expect(isApprovable({ countId: "c", status: "OK", blockedReason: null })).toBe(true);
    expect(isApprovable({ countId: "c", status: "DIFF", blockedReason: "MATERIAL_INACTIVE" })).toBe(false);
    expect(isApprovable({ countId: "c", status: "RECOUNT", blockedReason: null })).toBe(false);
    expect(isApprovable({ countId: null, status: "UNCOUNTED", blockedReason: null })).toBe(false);
    expect(isApprovable({ countId: "c", status: "APPROVED", blockedReason: null })).toBe(false);
  });

  it("nadrezerwacja: Σ rezerwacji > stan aktywny po różnicach w dół (różnice w nieaktywnych lokalizacjach pomijane)", () => {
    const base = { materialId: "m", materialCode: "M1", unit: "szt.", materialStockActive: 10, materialReserved: 8 };
    expect(overReservationAfterApprove([{ ...base, locationActive: true, difference: -1 }])).toEqual([]);
    expect(overReservationAfterApprove([{ ...base, locationActive: true, difference: -3 }])).toEqual([
      "M1: zarezerwowane 8 szt., stan po zatwierdzeniu 7 szt.",
    ]);
    expect(
      overReservationAfterApprove([
        { ...base, locationActive: true, difference: -2 },
        { ...base, locationActive: true, difference: -1 },
      ]),
    ).toHaveLength(1);
    expect(overReservationAfterApprove([{ ...base, locationActive: false, difference: -5 }])).toEqual([]);
    expect(overReservationAfterApprove([{ ...base, materialStockActive: 5, locationActive: true, difference: 1 }])).toEqual([]);
  });
});

describe("ekran liczenia (terminal)", () => {
  const item = (over: Partial<CountingItemDto>): CountingItemDto => ({
    materialId: "m1",
    code: "M1",
    name: "Materiał",
    unit: "szt.",
    allowsFraction: false,
    active: true,
    expected: true,
    countedQuantity: null,
    countedAt: null,
    countedByName: null,
    state: null,
    ...over,
  });

  it("initialRows: COUNTED i APPROVED wypełnione, RECOUNT i nowe puste", () => {
    const rows = initialRows([
      item({ materialId: "a", state: "COUNTED", countedQuantity: 4 }),
      item({ materialId: "b", state: "RECOUNT", countedQuantity: 3 }),
      item({ materialId: "c", state: "APPROVED", countedQuantity: 2.5, allowsFraction: true }),
      item({ materialId: "d" }),
    ]);
    expect(rows.map((r) => r.text)).toEqual(["4", "", "2,5", ""]);
    expect(rows.map((r) => r.previous)).toEqual([4, 3, 2.5, null]);
  });

  it("addRow: nowy materiał dodany raz; istniejący — informacja", () => {
    const rows = initialRows([item({ materialId: "a" })]);
    const added = addRow(rows, { id: "x", code: "X", name: "X", unit: "mb", allowsFraction: true });
    expect(added.existed).toBe(false);
    expect(added.rows.at(-1)).toMatchObject({ materialId: "x", added: true, expected: false, text: "" });
    expect(addRow(added.rows, { id: "a", code: "A", name: "A", unit: "szt.", allowsFraction: false }).existed).toBe(true);
  });

  it("buildCountItems: 0 i przecinek; puste — niepoliczone / usunięcie; zatwierdzone pominięte; błędy pól", () => {
    const rows = initialRows([
      item({ materialId: "a" }),
      item({ materialId: "b", state: "COUNTED", countedQuantity: 3 }),
      item({ materialId: "c", state: "APPROVED", countedQuantity: 2 }),
      item({ materialId: "d", allowsFraction: true }),
      item({ materialId: "e" }),
    ]).map((r) => (r.materialId === "a" ? { ...r, text: "0" } : r.materialId === "b" ? { ...r, text: "" } : r.materialId === "d" ? { ...r, text: "1,25" } : r));
    const built = buildCountItems(rows);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.items).toEqual([
      { material_id: "a", quantity: 0 },
      { material_id: "d", quantity: 1.25 },
    ]);
    expect(built.removed.map((r) => r.materialId)).toEqual(["b"]);
    expect(built.uncounted.map((r) => r.materialId)).toEqual(["e"]);

    const bad = buildCountItems(initialRows([item({ materialId: "a" })]).map((r) => ({ ...r, text: "1,5" })));
    expect(bad.ok ? null : bad.errors).toEqual({ a: "Ten materiał liczy się w całych jednostkach (bez ułamków)" });
    expect(buildCountItems(initialRows([item({ materialId: "a" })]).map((r) => ({ ...r, text: "-1" }))).ok).toBe(false);
  });

  it("mechanizm prób: wynik nieznany → ponowienie wysyła ten sam id i payload; błąd domenowy → nowy id", () => {
    const payload = { client_request_id: "", started_at: STARTED, items: [{ material_id: MAT, quantity: 1 }] };
    let n = 0;
    const makeId = () => `id-${++n}`;
    const first = startSend(initialAttempt<typeof payload>(), payload, makeId)!;
    expect(first.requestId).toBe("id-1");
    const unknown = finishSend(first.next, "network");
    expect(unknown.status).toBe("unknown");
    const changed = { ...payload, items: [{ material_id: MAT, quantity: 9 }] };
    const retry = startSend(unknown, changed, makeId)!;
    expect(retry.requestId).toBe("id-1");
    expect(retry.payload).toBe(payload);
    expect(startSend(retry.next, payload, makeId)).toBeNull(); // podwójne tapnięcie w trakcie wysyłania
    const afterDomain = finishSend(retry.next, "error");
    expect(startSend(afterDomain, changed, makeId)!.requestId).toBe("id-2");
  });
});
