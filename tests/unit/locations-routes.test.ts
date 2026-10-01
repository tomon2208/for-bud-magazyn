import { beforeEach, describe, expect, it, vi } from "vitest";

// Testy route handlerów /api/v1/locations. Mock sesji/profilu i serwisu — jeśli handler nie sprawdzi
// roli/walidacji, serwis zostanie wywołany i testy polegną.

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
  listLocations: vi.fn(),
  getLocation: vi.fn(),
  getLocationByCode: vi.fn(),
  createLocation: vi.fn(),
  updateLocation: vi.fn(),
  createLocationsBulk: vi.fn(),
}));
vi.mock("@/server/locations", () => service);

const locations = await import("@/app/api/v1/locations/route");
const locationById = await import("@/app/api/v1/locations/[id]/route");
const bulk = await import("@/app/api/v1/locations/bulk/route");
const byCode = await import("@/app/api/v1/locations/by-code/[code]/route");

const BASE = "http://localhost:8787";
const ID = "6f1c1e0a-2b0d-4c3e-9f5a-1b2c3d4e5f60";

function jsonRequest(method: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(new URL(path, BASE), {
    method,
    headers: { "content-type": "application/json", origin: BASE, ...headers },
    body: JSON.stringify(body),
  });
}
const getRequest = (path: string) => new Request(new URL(path, BASE));
const idCtx = (id = ID) => ({ params: Promise.resolve({ id }) }) as never;
const codeCtx = (code: string) => ({ params: Promise.resolve({ code }) }) as never;

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
  for (const fn of Object.values(service)) fn.mockReset().mockResolvedValue({ ok: true, data: {} });
});

const serviceCalls = () => Object.values(service).reduce((n, fn) => n + fn.mock.calls.length, 0);

type Case = { name: string; allowed: string[]; call: () => Promise<Response> };
const ALL = ["ADMIN", "BIURO", "PRODUKCJA"];

const cases: Case[] = [
  { name: "GET /locations", allowed: ALL, call: () => locations.GET(getRequest("/api/v1/locations")) },
  { name: "GET /locations/[id]", allowed: ALL, call: () => locationById.GET(getRequest("/x"), idCtx()) },
  { name: "GET /locations/by-code/[code]", allowed: ALL, call: () => byCode.GET(getRequest("/x"), codeCtx("A-01-01")) },
  { name: "POST /locations", allowed: ["ADMIN"], call: () => locations.POST(jsonRequest("POST", "/api/v1/locations", { code: "a-1" })) },
  { name: "PATCH /locations/[id]", allowed: ["ADMIN"], call: () => locationById.PATCH(jsonRequest("PATCH", "/x", { active: false }), idCtx()) },
  {
    name: "POST /locations/bulk",
    allowed: ["ADMIN"],
    call: () => bulk.POST(jsonRequest("POST", "/api/v1/locations/bulk", { items: [{ code: "A-01-01" }] })),
  },
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

describe("walidacja i CSRF (ADMIN)", () => {
  beforeEach(() => as("ADMIN"));

  it("POST /locations: przekazuje znormalizowane dane i zwraca 201", async () => {
    const res = await locations.POST(jsonRequest("POST", "/api/v1/locations", { code: " a-03-02 ", name: " Regał " }));
    expect(res.status).toBe(201);
    expect(service.createLocation).toHaveBeenCalledWith(expect.anything(), { code: "A-03-02", name: "Regał" });
  });

  it.each([
    ["POST /locations", () => locations.POST],
    ["POST /locations/bulk", () => bulk.POST],
  ])("%s: text/plain → 415, obcy Origin → 403, brak Origin → 403", async (_n, pick) => {
    const post = pick();
    const body = { code: "A-1", items: [{ code: "A-1" }] };
    const path = "/api/v1/locations";
    expect((await post(jsonRequest("POST", path, body, { "content-type": "text/plain" }))).status).toBe(415);
    expect((await post(jsonRequest("POST", path, body, { origin: "https://evil.example" }))).status).toBe(403);
    const noOrigin = new Request(new URL(path, BASE), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect((await post(noOrigin)).status).toBe(403);
    expect(serviceCalls()).toBe(0);
  });

  it("PATCH z text/plain → 415", async () => {
    const res = await locationById.PATCH(jsonRequest("PATCH", "/x", { active: false }, { "content-type": "text/plain" }), idCtx());
    expect(res.status).toBe(415);
    expect(serviceCalls()).toBe(0);
  });

  it("niepoprawne dane → 400 VALIDATION z polami", async () => {
    const res = await locations.POST(jsonRequest("POST", "/api/v1/locations", { code: "a b" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION");
    expect(Object.keys(body.error.fields)).toContain("code");
    expect(serviceCalls()).toBe(0);
  });

  it("nieznane pola (created_by, id) → 400", async () => {
    expect((await locations.POST(jsonRequest("POST", "/api/v1/locations", { code: "A", created_by: ID }))).status).toBe(400);
    expect((await locationById.PATCH(jsonRequest("PATCH", "/x", { id: ID }), idCtx())).status).toBe(400);
    expect(serviceCalls()).toBe(0);
  });

  it("zły identyfikator w ścieżce → 400", async () => {
    expect((await locationById.GET(getRequest("/x"), idCtx("nie-uuid"))).status).toBe(400);
    expect((await locationById.PATCH(jsonRequest("PATCH", "/x", { active: false }), idCtx("x"))).status).toBe(400);
    expect(serviceCalls()).toBe(0);
  });

  it("GET /locations: parametry listy walidowane i przekazywane", async () => {
    expect((await locations.GET(getRequest("/api/v1/locations?pageSize=101"))).status).toBe(400);
    expect(service.listLocations).not.toHaveBeenCalled();
    await locations.GET(getRequest("/api/v1/locations?q=abc&includeInactive=true&page=2&pageSize=50"));
    expect(service.listLocations).toHaveBeenCalledWith(expect.anything(), {
      q: "abc",
      includeInactive: true,
      page: 2,
      pageSize: 50,
    });
  });

  it("brak lokalizacji → 404 z serwisu", async () => {
    service.getLocation.mockResolvedValue({ ok: false, error: { status: 404, code: "NOT_FOUND", message: "Nie znaleziono lokalizacji" } });
    expect((await locationById.GET(getRequest("/x"), idCtx())).status).toBe(404);
  });

  it("duplikat kodu → 409 CODE_TAKEN", async () => {
    service.createLocation.mockResolvedValue({ ok: false, error: { status: 409, code: "CODE_TAKEN", message: "x" } });
    const res = await locations.POST(jsonRequest("POST", "/api/v1/locations", { code: "A-1" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "CODE_TAKEN" } });
  });
});

describe("bulk", () => {
  beforeEach(() => as("ADMIN"));

  it("201 i dane z serwisu", async () => {
    service.createLocationsBulk.mockResolvedValue({ ok: true, data: [{ code: "A-01-01" }] });
    const res = await bulk.POST(jsonRequest("POST", "/x", { items: [{ code: "a-01-01" }] }));
    expect(res.status).toBe(201);
    expect(service.createLocationsBulk).toHaveBeenCalledWith(expect.anything(), { items: [{ code: "A-01-01" }] });
  });

  it("201 elementów → 400, duplikaty na liście → 400, puste → 400", async () => {
    const many = Array.from({ length: 201 }, (_, i) => ({ code: `A-${i}` }));
    expect((await bulk.POST(jsonRequest("POST", "/x", { items: many }))).status).toBe(400);
    expect((await bulk.POST(jsonRequest("POST", "/x", { items: [{ code: "A" }, { code: "a" }] }))).status).toBe(400);
    expect((await bulk.POST(jsonRequest("POST", "/x", { items: [] }))).status).toBe(400);
    expect((await bulk.POST(jsonRequest("POST", "/x", { items: [{ code: "A", id: ID }] }))).status).toBe(400);
    expect(serviceCalls()).toBe(0);
  });

  it("409 z listą zajętych kodów w fields", async () => {
    service.createLocationsBulk.mockResolvedValue({
      ok: false,
      error: { status: 409, code: "CODE_TAKEN", message: "Te kody już istnieją: A-01-01", fields: { codes: ["A-01-01"] } },
    });
    const res = await bulk.POST(jsonRequest("POST", "/x", { items: [{ code: "A-01-01" }] }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "CODE_TAKEN", fields: { codes: ["A-01-01"] } } });
  });
});

describe("GET /locations/by-code/[...code]", () => {
  beforeEach(() => as("PRODUKCJA"));

  it("przekazuje kod (zdekodowany) do serwisu", async () => {
    await byCode.GET(getRequest("/x"), codeCtx("a.b_1-2"));
    expect(service.getLocationByCode).toHaveBeenCalledWith(expect.anything(), "a.b_1-2");
  });

  it("zepsute kodowanie procentowe → 404 UNKNOWN_CODE (nie 500)", async () => {
    const res = await byCode.GET(getRequest("/x"), codeCtx("%E0%A4%A"));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "UNKNOWN_CODE", message: "Nieznany kod lokalizacji" } });
    expect(service.getLocationByCode).not.toHaveBeenCalled();
  });

  it("nieznany kod → 404 UNKNOWN_CODE z czytelnym komunikatem", async () => {
    service.getLocationByCode.mockResolvedValue({
      ok: false,
      error: { status: 404, code: "UNKNOWN_CODE", message: "Nieznany kod lokalizacji" },
    });
    const res = await byCode.GET(getRequest("/x"), codeCtx("ZZZ"));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "UNKNOWN_CODE", message: "Nieznany kod lokalizacji" } });
  });

  it("nieaktywna lokalizacja → 200 z active:false", async () => {
    service.getLocationByCode.mockResolvedValue({ ok: true, data: { code: "A-1", active: false } });
    const res = await byCode.GET(getRequest("/x"), codeCtx("A-1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { code: "A-1", active: false } });
  });
});
