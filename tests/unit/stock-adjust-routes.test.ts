import { beforeEach, describe, expect, it, vi } from "vitest";

// Route handlery Etapu 6: korekta (ADMIN), storno (ADMIN), historia ruchów (wszyscy; PRODUKCJA — własne w DB),
// kontrola spójności (ADMIN). Mock sesji i serwisu — handler bez kontroli roli/CSRF/walidacji wywołałby serwis.

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
  createAdjustment: vi.fn(),
  createReversal: vi.fn(),
  listMovements: vi.fn(),
  verifyStock: vi.fn(),
}));
vi.mock("@/server/stock", () => service);

const adjustments = await import("@/app/api/v1/stock/adjustments/route");
const reversals = await import("@/app/api/v1/stock/reversals/route");
const movements = await import("@/app/api/v1/stock/movements/route");
const verify = await import("@/app/api/v1/stock/verify/route");

const BASE = "http://localhost:8787";
const CRID = "0b8f8a3e-4a4c-4c86-9a43-0f0f7e1d2c3b";
const LOC = "6f1c1e0a-2b0d-4c3e-9f5a-1b2c3d4e5f60";
const MAT = "7a2d2f1b-3c1e-4d4f-8a6b-2c3d4e5f6071";
const OP = "8b3e3a2c-4d2f-4e5a-9b7c-3d4e5f607182";
const USER = "9c4f4b3d-5e3a-4f6b-8c8d-4e5f60718293";

const adjustBody = {
  client_request_id: CRID,
  material_id: MAT,
  location_id: LOC,
  target_quantity: "3",
  expected_current: 5,
  reason_code: "ZAGINIECIE",
};
const reverseBody = { client_request_id: CRID, operation_id: OP, reason: "pomyłka" };

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(new URL(path, BASE), {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, ...headers },
    body: JSON.stringify(body),
  });
}
const adjReq = (body: unknown, h: Record<string, string> = {}) => post("/api/v1/stock/adjustments", body, h);
const revReq = (body: unknown, h: Record<string, string> = {}) => post("/api/v1/stock/reversals", body, h);
const getRequest = (path: string) => new Request(new URL(path, BASE));

function as(role: string | null, active = true) {
  if (role === null) {
    state.sub = null;
    state.profile = null;
    return;
  }
  state.sub = "actor-id";
  state.profile = { id: "actor-id", login: "actor", full_name: "Actor", role, active };
}

beforeEach(() => {
  as(null);
  for (const fn of Object.values(service)) fn.mockReset().mockResolvedValue({ ok: true, data: { items: [], total: 0 } });
  service.createAdjustment.mockResolvedValue({ ok: true, data: { idempotentReplay: false, newQuantity: 3 } });
  service.createReversal.mockResolvedValue({ ok: true, data: { idempotentReplay: false, movements: [] } });
  service.verifyStock.mockResolvedValue({ ok: true, data: { checkedAt: "x", discrepancies: [] } });
});

const serviceCalls = () => Object.values(service).reduce((n, fn) => n + fn.mock.calls.length, 0);

const ALL = ["ADMIN", "BIURO", "PRODUKCJA"];
const cases = [
  { name: "POST /stock/adjustments", allowed: ["ADMIN"], call: () => adjustments.POST(adjReq(adjustBody)) },
  { name: "POST /stock/reversals", allowed: ["ADMIN"], call: () => reversals.POST(revReq(reverseBody)) },
  { name: "GET /stock/movements (PRODUKCJA: tylko własne — wymusza DB)", allowed: ALL, call: () => movements.GET(getRequest("/api/v1/stock/movements")) },
  { name: "GET /stock/verify", allowed: ["ADMIN"], call: () => verify.GET() },
];

describe.each(cases)("$name — uprawnienia", ({ allowed, call }) => {
  it("bez sesji → 401", async () => {
    expect((await call()).status).toBe(401);
    expect(serviceCalls()).toBe(0);
  });

  it("nieaktywny ADMIN → 401", async () => {
    as("ADMIN", false);
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

describe("POST /stock/adjustments", () => {
  beforeEach(() => as("ADMIN"));

  it("201 nowa korekta; ilości z przecinkiem → liczby; puste opcjonalne → null", async () => {
    const res = await adjustments.POST(adjReq({ ...adjustBody, target_quantity: "2,5", expected_current: "0", reason: "  ", note: " n " }));
    expect(res.status).toBe(201);
    expect(service.createAdjustment).toHaveBeenCalledWith(expect.anything(), {
      ...adjustBody,
      target_quantity: 2.5,
      expected_current: 0,
      reason: null,
      note: "n",
    });
  });

  it("korekta do zera (target 0) jest dozwolona", async () => {
    expect((await adjustments.POST(adjReq({ ...adjustBody, target_quantity: 0 }))).status).toBe(201);
  });

  it("200 dla powtórzenia idempotentnego", async () => {
    service.createAdjustment.mockResolvedValue({ ok: true, data: { idempotentReplay: true } });
    expect((await adjustments.POST(adjReq(adjustBody))).status).toBe(200);
  });

  it("409 STOCK_CHANGED z aktualnym stanem w odpowiedzi", async () => {
    service.createAdjustment.mockResolvedValue({
      ok: false,
      error: { status: 409, code: "STOCK_CHANGED", message: "teraz 4", details: { current: 4 } },
    });
    const res = await adjustments.POST(adjReq(adjustBody));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "STOCK_CHANGED", message: "teraz 4", details: { current: 4 } } });
  });

  it("409 NO_CHANGE z serwisu", async () => {
    service.createAdjustment.mockResolvedValue({ ok: false, error: { status: 409, code: "NO_CHANGE", message: "Stan się zgadza — brak korekty" } });
    const res = await adjustments.POST(adjReq(adjustBody));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("NO_CHANGE");
  });

  it("CSRF: text/plain → 415, obcy Origin → 403, brak Origin → 403", async () => {
    expect((await adjustments.POST(adjReq(adjustBody, { "content-type": "text/plain" }))).status).toBe(415);
    expect((await adjustments.POST(adjReq(adjustBody, { origin: "https://evil.example" }))).status).toBe(403);
    const noOrigin = new Request(new URL("/api/v1/stock/adjustments", BASE), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(adjustBody),
    });
    expect((await adjustments.POST(noOrigin)).status).toBe(403);
    expect(serviceCalls()).toBe(0);
  });

  it.each([
    ["target ujemny", { ...adjustBody, target_quantity: "-1" }, "target_quantity"],
    ["target 4 miejsca", { ...adjustBody, target_quantity: "1,2345" }, "target_quantity"],
    ["target > 1 000 000", { ...adjustBody, target_quantity: 1_000_001 }, "target_quantity"],
    ["target tekst", { ...adjustBody, target_quantity: "abc" }, "target_quantity"],
    ["brak expected_current", { ...adjustBody, expected_current: undefined }, "expected_current"],
    ["expected ujemny", { ...adjustBody, expected_current: -1 }, "expected_current"],
    ["brak powodu", { ...adjustBody, reason_code: undefined }, "reason_code"],
    ["powód wydania (SERWIS) nie jest powodem korekty", { ...adjustBody, reason_code: "SERWIS" }, "reason_code"],
    ["INNY bez opisu", { ...adjustBody, reason_code: "INNY" }, "reason"],
    ["INNY z pustym opisem", { ...adjustBody, reason_code: "INNY", reason: "   " }, "reason"],
    ["opis > 200", { ...adjustBody, reason: "x".repeat(201) }, "reason"],
    ["lokalizacja nie-uuid", { ...adjustBody, location_id: "x" }, "location_id"],
    ["nieznane pole (quantity_delta)", { ...adjustBody, quantity_delta: 2 }, "_"],
  ])("%s → 400 VALIDATION", async (_n, body, field) => {
    const res = await adjustments.POST(adjReq(body));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("VALIDATION");
    expect(Object.keys(json.error.fields)).toContain(field);
    expect(serviceCalls()).toBe(0);
  });
});

describe("POST /stock/reversals", () => {
  beforeEach(() => as("ADMIN"));

  it("201 nowe storno (powód przycięty), 200 replay", async () => {
    expect((await reversals.POST(revReq({ ...reverseBody, reason: "  pomyłka " }))).status).toBe(201);
    expect(service.createReversal).toHaveBeenCalledWith(expect.anything(), { ...reverseBody, reason: "pomyłka" });
    service.createReversal.mockResolvedValue({ ok: true, data: { idempotentReplay: true } });
    expect((await reversals.POST(revReq(reverseBody))).status).toBe(200);
  });

  it.each([
    ["ALREADY_REVERSED", {}],
    ["NOT_REVERSIBLE", {}],
    ["INSUFFICIENT_STOCK", { details: { available: 2, locationCode: "A-01" } }],
  ])("409 %s z serwisu (szczegóły przekazane)", async (code, extra) => {
    service.createReversal.mockResolvedValue({ ok: false, error: { status: 409, code, message: "x", ...extra } });
    const res = await reversals.POST(revReq(reverseBody));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code, message: "x", ...extra } });
  });

  it("CSRF: text/plain → 415, obcy Origin → 403", async () => {
    expect((await reversals.POST(revReq(reverseBody, { "content-type": "text/plain" }))).status).toBe(415);
    expect((await reversals.POST(revReq(reverseBody, { origin: "https://evil.example" }))).status).toBe(403);
    expect(serviceCalls()).toBe(0);
  });

  it.each([
    ["brak powodu", { ...reverseBody, reason: undefined }, "reason"],
    ["powód 2 znaki", { ...reverseBody, reason: " ab " }, "reason"],
    ["powód > 200", { ...reverseBody, reason: "x".repeat(201) }, "reason"],
    ["operacja nie-uuid", { ...reverseBody, operation_id: "x" }, "operation_id"],
    ["nieznane pole", { ...reverseBody, material_id: MAT }, "_"],
  ])("%s → 400 VALIDATION", async (_n, body, field) => {
    const res = await reversals.POST(revReq(body));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("VALIDATION");
    expect(Object.keys(json.error.fields)).toContain(field);
    expect(serviceCalls()).toBe(0);
  });
});

describe("GET /stock/movements — filtry", () => {
  it("wszystkie filtry przekazane; przesunięcia zwinięte", async () => {
    as("BIURO");
    await movements.GET(
      getRequest(
        `/api/v1/stock/movements?type=REVERSAL&q=k5&materialId=${MAT}&locationId=${LOC}&userId=${USER}&orderId=${OP}&operationId=${OP}&from=2026-10-01&to=2026-10-02&page=3&pageSize=10`,
      ),
    );
    expect(service.listMovements).toHaveBeenCalledWith(
      expect.anything(),
      {
        type: "REVERSAL",
        q: "k5",
        materialId: MAT,
        locationId: LOC,
        userId: USER,
        orderId: OP,
        operationId: OP,
        from: "2026-10-01",
        to: "2026-10-02",
        page: 3,
        pageSize: 10,
      },
      { collapseTransfers: true },
    );
  });

  it.each(["type=FOO", "userId=x", "locationId=1", "operationId=abc", "from=2026-10-02&to=2026-10-01", "page=0", "pageSize=1000"])(
    "%s → 400",
    async (qs) => {
      as("ADMIN");
      expect((await movements.GET(getRequest(`/api/v1/stock/movements?${qs}`))).status).toBe(400);
      expect(serviceCalls()).toBe(0);
    },
  );
});
