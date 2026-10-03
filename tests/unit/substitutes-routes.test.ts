import { beforeEach, describe, expect, it, vi } from "vitest";

// Route handlery odpowiedników (Etap 12b): pary w karcie materiału (odczyt — każda rola, zapis — ADMIN), „Podmień”
// (BIURO, ADMIN), wydanie z substitute_for (PRODUKCJA, ADMIN). Serwisy zamockowane — jeśli handler nie sprawdzi
// roli/CSRF/walidacji, serwis zostanie wywołany i test polegnie.

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

const subst = vi.hoisted(() => ({
  listMaterialSubstitutes: vi.fn(),
  addMaterialSubstitute: vi.fn(),
  removeMaterialSubstitute: vi.fn(),
}));
vi.mock("@/server/substitutes", () => subst);

const reqs = vi.hoisted(() => ({ substituteRequirementItem: vi.fn() }));
vi.mock("@/server/requirements", () => reqs);

const stock = vi.hoisted(() => ({ createIssue: vi.fn() }));
vi.mock("@/server/stock", () => stock);

const listRoute = await import("@/app/api/v1/materials/[id]/substitutes/route");
const pairRoute = await import("@/app/api/v1/materials/[id]/substitutes/[pairId]/route");
const substRoute = await import("@/app/api/v1/requirements/[id]/substitute/route");
const issueRoute = await import("@/app/api/v1/stock/issues/route");

const BASE = "http://localhost:8787";
const ID = "6f1c1e0a-2b0d-4c3e-9f5a-1b2c3d4e5f60";
const MAT = "7a2d2f1b-3c1e-4d4f-8a6b-2c3d4e5f6071";
const MAT2 = "8b3e3a2c-4d2f-4e5a-9b7c-3d4e5f607182";
const PAIR = "9c4f4b3d-5e3a-4f6b-8c8d-4e5f60718293";
const CRID = "0b8f8a3e-4a4c-4c86-9a43-0f0f7e1d2c3b";

const ctx = (id = ID) => ({ params: Promise.resolve({ id }) }) as never;
const pairCtx = (id = ID, pairId = PAIR) => ({ params: Promise.resolve({ id, pairId }) }) as never;
const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(new URL(path, BASE), {
    method,
    headers: { "content-type": "application/json", origin: BASE, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
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

const all = [...Object.values(subst), ...Object.values(reqs), ...Object.values(stock)];
const calls = () => all.reduce((n, fn) => n + fn.mock.calls.length, 0);

beforeEach(() => {
  as(null);
  for (const fn of all) fn.mockReset().mockResolvedValue({ ok: true, data: { id: PAIR, alreadyExisted: false, idempotentReplay: false } });
});

const substBody = { client_request_id: CRID, from_material_id: MAT, to_material_id: MAT2, reason: " brak u dostawcy " };
const issueBody = { client_request_id: CRID, location_id: ID, material_id: MAT2, quantity: "2", production_order_id: PAIR, substitute_for: MAT };

type Case = { name: string; allowed: string[]; call: () => Promise<Response> };
const ALL = ["ADMIN", "BIURO", "PRODUKCJA"];
const cases: Case[] = [
  { name: "GET /materials/[id]/substitutes", allowed: ALL, call: () => listRoute.GET(req("GET", `/api/v1/materials/${ID}/substitutes`), ctx()) },
  {
    name: "POST /materials/[id]/substitutes",
    allowed: ["ADMIN"],
    call: () => listRoute.POST(req("POST", `/api/v1/materials/${ID}/substitutes`, { substitute_id: MAT }), ctx()),
  },
  {
    name: "DELETE /materials/[id]/substitutes/[pairId]",
    allowed: ["ADMIN"],
    call: () => pairRoute.DELETE(req("DELETE", `/api/v1/materials/${ID}/substitutes/${PAIR}`), pairCtx()),
  },
  {
    name: "POST /requirements/[id]/substitute",
    allowed: ["ADMIN", "BIURO"],
    call: () => substRoute.POST(req("POST", `/api/v1/requirements/${ID}/substitute`, substBody), ctx()),
  },
  { name: "POST /stock/issues (zamiennik)", allowed: ["ADMIN", "PRODUKCJA"], call: () => issueRoute.POST(req("POST", "/api/v1/stock/issues", issueBody)) },
];

describe.each(cases)("$name — uprawnienia", ({ allowed, call }) => {
  it("bez sesji → 401", async () => {
    expect((await call()).status).toBe(401);
    expect(calls()).toBe(0);
  });
  for (const role of ALL) {
    it(`${role} → ${allowed.includes(role) ? "dozwolone" : "403"}`, async () => {
      as(role);
      const res = await call();
      if (allowed.includes(role)) {
        expect(res.status).toBeLessThan(300);
        expect(calls()).toBe(1);
      } else {
        expect(res.status).toBe(403);
        expect(calls()).toBe(0);
      }
    });
  }
});

describe("pary odpowiedników", () => {
  beforeEach(() => as("ADMIN"));

  it("POST: 201 nowa para, 200 istniejąca; serwis dostaje (materiał, odpowiednik)", async () => {
    const path = `/api/v1/materials/${ID}/substitutes`;
    expect((await listRoute.POST(req("POST", path, { substitute_id: MAT }), ctx())).status).toBe(201);
    expect(subst.addMaterialSubstitute).toHaveBeenCalledWith(expect.anything(), ID, MAT);
    subst.addMaterialSubstitute.mockResolvedValue({ ok: true, data: { id: PAIR, alreadyExisted: true } });
    expect((await listRoute.POST(req("POST", path, { substitute_id: MAT }), ctx())).status).toBe(200);
  });

  it("POST: sam ze sobą → 400 SAME_MATERIAL; zła treść / CSRF → 400/403/415 bez wywołania serwisu", async () => {
    const path = `/api/v1/materials/${ID}/substitutes`;
    const same = await listRoute.POST(req("POST", path, { substitute_id: ID }), ctx());
    expect(same.status).toBe(400);
    expect(((await same.json()) as { error: { code: string } }).error.code).toBe("SAME_MATERIAL");
    expect((await listRoute.POST(req("POST", path, { substitute_id: "x" }), ctx())).status).toBe(400);
    expect((await listRoute.POST(req("POST", path, { substitute_id: MAT, extra: 1 }), ctx())).status).toBe(400);
    expect((await listRoute.POST(req("POST", path, { substitute_id: MAT }, { origin: "https://evil.example" }), ctx())).status).toBe(403);
    expect((await listRoute.POST(req("POST", path, { substitute_id: MAT }, { "content-type": "text/plain" }), ctx())).status).toBe(415);
    expect((await listRoute.POST(req("POST", "/api/v1/materials/x/substitutes", { substitute_id: MAT }), ctx("x"))).status).toBe(400);
    expect(calls()).toBe(0);
  });

  it("DELETE: CSRF i zły identyfikator → bez serwisu; 404 z serwisu", async () => {
    const path = `/api/v1/materials/${ID}/substitutes/${PAIR}`;
    expect((await pairRoute.DELETE(req("DELETE", path, undefined, { origin: "https://evil.example" }), pairCtx())).status).toBe(403);
    expect((await pairRoute.DELETE(req("DELETE", path), pairCtx(ID, "x"))).status).toBe(400);
    expect(calls()).toBe(0);
    subst.removeMaterialSubstitute.mockResolvedValue({ ok: false, error: { status: 404, code: "NOT_FOUND", message: "x" } });
    expect((await pairRoute.DELETE(req("DELETE", path), pairCtx())).status).toBe(404);
    expect(subst.removeMaterialSubstitute).toHaveBeenCalledWith(expect.anything(), PAIR);
  });

  it("GET: lista w { items }", async () => {
    subst.listMaterialSubstitutes.mockResolvedValue({ ok: true, data: [{ id: PAIR }] });
    const res = await listRoute.GET(req("GET", `/api/v1/materials/${ID}/substitutes`), ctx());
    expect(await res.json()).toEqual({ data: { items: [{ id: PAIR }] } });
  });
});

describe("POST /requirements/[id]/substitute", () => {
  beforeEach(() => as("BIURO"));
  const path = `/api/v1/requirements/${ID}/substitute`;

  it("201 nowa lista (powód przycięty), 200 powtórzenie", async () => {
    reqs.substituteRequirementItem.mockResolvedValue({ ok: true, data: { requirementId: PAIR, idempotentReplay: false } });
    expect((await substRoute.POST(req("POST", path, substBody), ctx())).status).toBe(201);
    expect(reqs.substituteRequirementItem).toHaveBeenCalledWith(expect.anything(), ID, {
      client_request_id: CRID,
      from_material_id: MAT,
      to_material_id: MAT2,
      reason: "brak u dostawcy",
    });
    reqs.substituteRequirementItem.mockResolvedValue({ ok: true, data: { requirementId: PAIR, idempotentReplay: true } });
    expect((await substRoute.POST(req("POST", path, substBody), ctx())).status).toBe(200);
  });

  it.each([
    ["brak client_request_id", { from_material_id: MAT, to_material_id: MAT2 }],
    ["ten sam materiał", { ...substBody, to_material_id: MAT }],
    ["za długi powód", { ...substBody, reason: "x".repeat(201) }],
    ["nieznane pole", { ...substBody, quantity: 5 }],
  ])("%s → 400", async (_n, body) => {
    expect((await substRoute.POST(req("POST", path, body), ctx())).status).toBe(400);
    expect(calls()).toBe(0);
  });

  it("błędy domenowe: 409 NOTHING_TO_SUBSTITUTE / ALREADY_WITHDRAWN, 400 NOT_A_SUBSTITUTE; CSRF", async () => {
    for (const [status, code] of [
      [409, "NOTHING_TO_SUBSTITUTE"],
      [409, "ALREADY_WITHDRAWN"],
      [400, "NOT_A_SUBSTITUTE"],
    ] as const) {
      reqs.substituteRequirementItem.mockResolvedValue({ ok: false, error: { status, code, message: "x" } });
      const res = await substRoute.POST(req("POST", path, substBody), ctx());
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
    }
    expect((await substRoute.POST(req("POST", path, substBody, { origin: "https://evil.example" }), ctx())).status).toBe(403);
  });
});

describe("POST /stock/issues — substitute_for", () => {
  beforeEach(() => as("PRODUKCJA"));

  it("przekazany do serwisu; bez zlecenia albo równy materiałowi → 400", async () => {
    stock.createIssue.mockResolvedValue({ ok: true, data: { idempotentReplay: false } });
    expect((await issueRoute.POST(req("POST", "/api/v1/stock/issues", issueBody))).status).toBe(201);
    expect(stock.createIssue).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ substitute_for: MAT, material_id: MAT2 }));
    const noOrder = { ...issueBody, production_order_id: null, reason_code: "SERWIS" };
    expect((await issueRoute.POST(req("POST", "/api/v1/stock/issues", noOrder))).status).toBe(400);
    expect((await issueRoute.POST(req("POST", "/api/v1/stock/issues", { ...issueBody, substitute_for: MAT2 }))).status).toBe(400);
    expect(stock.createIssue).toHaveBeenCalledTimes(1);
  });

  it("błąd domenowy NOT_IN_REQUIREMENTS → 400", async () => {
    stock.createIssue.mockResolvedValue({ ok: false, error: { status: 400, code: "NOT_IN_REQUIREMENTS", message: "x" } });
    expect((await issueRoute.POST(req("POST", "/api/v1/stock/issues", issueBody))).status).toBe(400);
  });
});
