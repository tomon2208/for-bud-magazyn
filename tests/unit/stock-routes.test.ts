import { beforeEach, describe, expect, it, vi } from "vitest";

// Testy route handlerów /api/v1/stock. Mock sesji/profilu i serwisu — jeśli handler nie sprawdzi
// roli/CSRF/walidacji, serwis zostanie wywołany i testy polegną.

const state: { sub: string | null; profile: Record<string, unknown> | null } = { sub: null, profile: null };

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: {
      getClaims: async () =>
        state.sub ? { data: { claims: { sub: state.sub } }, error: null } : { data: null, error: null },
    },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: state.profile, error: null }) }),
      }),
    }),
  }),
}));

const service = vi.hoisted(() => ({
  createReceipt: vi.fn(),
  listStock: vi.fn(),
  listMovements: vi.fn(),
  listRecentReceiptMaterials: vi.fn(),
}));
vi.mock("@/server/stock", () => service);

const receipts = await import("@/app/api/v1/stock/receipts/route");
const stock = await import("@/app/api/v1/stock/route");
const operations = await import("@/app/api/v1/stock/operations/route");

const BASE = "http://localhost:8787";
const CRID = "0b8f8a3e-4a4c-4c86-9a43-0f0f7e1d2c3b";
const LOC = "6f1c1e0a-2b0d-4c3e-9f5a-1b2c3d4e5f60";
const MAT = "7a2d2f1b-3c1e-4d4f-8a6b-2c3d4e5f6071";

function jsonRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request(new URL("/api/v1/stock/receipts", BASE), {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, ...headers },
    body: JSON.stringify(body),
  });
}
const getRequest = (path: string) => new Request(new URL(path, BASE));
const validBody = { client_request_id: CRID, location_id: LOC, material_id: MAT, quantity: "1,5" };

function as(role: string | null, active = true) {
  if (role === null) {
    state.sub = null;
    state.profile = null;
    return;
  }
  state.sub = "actor-id";
  state.profile = { id: "actor-id", login: "actor", full_name: "Actor", role, active };
}

const receiptResult = (idempotentReplay: boolean) => ({
  ok: true,
  data: {
    operationId: "op",
    movementId: "mv",
    materialId: MAT,
    locationId: LOC,
    quantity: 1.5,
    newLocationQuantity: 3,
    idempotentReplay,
  },
});

beforeEach(() => {
  as(null);
  for (const fn of Object.values(service)) fn.mockReset().mockResolvedValue({ ok: true, data: { items: [], total: 0 } });
  service.createReceipt.mockResolvedValue(receiptResult(false));
});

const serviceCalls = () => Object.values(service).reduce((n, fn) => n + fn.mock.calls.length, 0);

type Case = { name: string; allowed: string[]; call: () => Promise<Response> };
const ALL = ["ADMIN", "BIURO", "PRODUKCJA"];
const cases: Case[] = [
  { name: "POST /stock/receipts", allowed: ["ADMIN", "PRODUKCJA"], call: () => receipts.POST(jsonRequest(validBody)) },
  { name: "GET /stock", allowed: ALL, call: () => stock.GET(getRequest("/api/v1/stock")) },
  {
    name: "GET /stock/operations (PRODUKCJA: tylko własne — wymusza DB)",
    allowed: ALL,
    call: () => operations.GET(getRequest("/api/v1/stock/operations?type=RECEIPT")),
  },
];

describe.each(cases)("$name — uprawnienia", ({ allowed, call }) => {
  it("bez sesji → 401", async () => {
    expect((await call()).status).toBe(401);
    expect(serviceCalls()).toBe(0);
  });

  it("nieaktywny → 401", async () => {
    as("PRODUKCJA", false);
    expect((await call()).status).toBe(401);
    expect(serviceCalls()).toBe(0);
  });

  for (const role of ALL) {
    if (allowed.includes(role)) {
      it(`${role} → dozwolone`, async () => {
        as(role);
        expect((await call()).status).toBeLessThan(300);
        expect(serviceCalls()).toBe(1);
      });
    } else {
      it(`${role} → 403`, async () => {
        as(role);
        const res = await call();
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
        expect(serviceCalls()).toBe(0);
      });
    }
  }
});

describe("POST /stock/receipts", () => {
  beforeEach(() => as("PRODUKCJA"));

  it("201 dla nowej operacji; ilość z przecinkiem → liczba; puste pola opcjonalne → null", async () => {
    const res = await receipts.POST(jsonRequest({ ...validBody, document_ref: " WZ/1 ", note: "  " }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ data: { idempotentReplay: false, newLocationQuantity: 3 } });
    expect(service.createReceipt).toHaveBeenCalledWith(expect.anything(), {
      client_request_id: CRID,
      location_id: LOC,
      material_id: MAT,
      quantity: 1.5,
      document_ref: "WZ/1",
      note: null,
    });
  });

  it("200 dla powtórzenia idempotentnego", async () => {
    service.createReceipt.mockResolvedValue(receiptResult(true));
    const res = await receipts.POST(jsonRequest(validBody));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { idempotentReplay: true } });
  });

  it("409 IDEMPOTENCY_CONFLICT z serwisu", async () => {
    service.createReceipt.mockResolvedValue({ ok: false, error: { status: 409, code: "IDEMPOTENCY_CONFLICT", message: "x" } });
    const res = await receipts.POST(jsonRequest(validBody));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
  });

  it("400 NOT_INTEGER z serwisu (np. 1,5 sztangi)", async () => {
    service.createReceipt.mockResolvedValue({ ok: false, error: { status: 400, code: "NOT_INTEGER", message: "x" } });
    expect((await receipts.POST(jsonRequest(validBody))).status).toBe(400);
  });

  it("CSRF: text/plain → 415, obcy Origin → 403, brak Origin → 403", async () => {
    expect((await receipts.POST(jsonRequest(validBody, { "content-type": "text/plain" }))).status).toBe(415);
    expect((await receipts.POST(jsonRequest(validBody, { origin: "https://evil.example" }))).status).toBe(403);
    const noOrigin = new Request(new URL("/api/v1/stock/receipts", BASE), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect((await receipts.POST(noOrigin)).status).toBe(403);
    expect(serviceCalls()).toBe(0);
  });

  it.each([
    ["brak client_request_id", { ...validBody, client_request_id: undefined }, "client_request_id"],
    ["client_request_id nie-uuid", { ...validBody, client_request_id: "abc" }, "client_request_id"],
    ["brak lokalizacji", { ...validBody, location_id: undefined }, "location_id"],
    ["materiał nie-uuid", { ...validBody, material_id: "x" }, "material_id"],
    ["ilość 0", { ...validBody, quantity: 0 }, "quantity"],
    ["ilość ujemna", { ...validBody, quantity: "-2" }, "quantity"],
    ["ilość 4 miejsca", { ...validBody, quantity: "1,2345" }, "quantity"],
    ["ilość za duża", { ...validBody, quantity: 1_000_001 }, "quantity"],
    ["ilość tekst", { ...validBody, quantity: "abc" }, "quantity"],
    ["ilość null", { ...validBody, quantity: null }, "quantity"],
    ["dokument > 100", { ...validBody, document_ref: "x".repeat(101) }, "document_ref"],
    ["notatka > 500", { ...validBody, note: "x".repeat(501) }, "note"],
    ["dostawca nie-uuid", { ...validBody, supplier_id: "x" }, "supplier_id"],
    ["nieznane pole (user_id)", { ...validBody, user_id: LOC }, "_"],
  ])("%s → 400 VALIDATION", async (_n, body, field) => {
    const res = await receipts.POST(jsonRequest(body));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("VALIDATION");
    expect(Object.keys(json.error.fields)).toContain(field);
    expect(serviceCalls()).toBe(0);
  });

  it("nieprawidłowy JSON → 400 INVALID_JSON", async () => {
    const req = new Request(new URL("/api/v1/stock/receipts", BASE), {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: "{",
    });
    const res = await receipts.POST(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "INVALID_JSON" } });
  });
});

describe("GET /stock i /stock/operations — parametry", () => {
  it("GET /stock: filtry przekazane, zły uuid → 400", async () => {
    as("PRODUKCJA");
    expect((await stock.GET(getRequest("/api/v1/stock?locationId=x"))).status).toBe(400);
    await stock.GET(getRequest(`/api/v1/stock?locationId=${LOC}&materialId=${MAT}`));
    expect(service.listStock).toHaveBeenCalledWith(expect.anything(), {
      locationId: LOC,
      materialId: MAT,
      page: 1,
      pageSize: 100,
    });
  });

  it("GET /stock/operations: typ, daty, strona; zły typ / zła data / od > do → 400", async () => {
    as("BIURO");
    for (const qs of ["type=FOO", "from=2026-13-45", "from=2026-10-02&to=2026-10-01", "page=0"]) {
      expect((await operations.GET(getRequest(`/api/v1/stock/operations?${qs}`))).status, qs).toBe(400);
    }
    expect(service.listMovements).not.toHaveBeenCalled();
    await operations.GET(getRequest("/api/v1/stock/operations?type=RECEIPT&q=k518&from=2026-10-01&to=2026-10-01&page=2"));
    expect(service.listMovements).toHaveBeenCalledWith(expect.anything(), {
      type: "RECEIPT",
      q: "k518",
      from: "2026-10-01",
      to: "2026-10-01",
      page: 2,
      pageSize: 25,
    });
  });
});
