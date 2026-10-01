import { beforeEach, describe, expect, it, vi } from "vitest";

// Testy route handlerów kartotek (/api/v1/categories|suppliers|materials). Mock sesji/profilu i serwisu —
// jeśli handler nie sprawdzi roli/walidacji, serwis zostanie wywołany i testy polegną.

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
  listCategories: vi.fn(),
  createCategory: vi.fn(),
  updateCategory: vi.fn(),
  listSuppliers: vi.fn(),
  createSupplier: vi.fn(),
  updateSupplier: vi.fn(),
  listMaterials: vi.fn(),
  getMaterial: vi.fn(),
  createMaterial: vi.fn(),
  updateMaterial: vi.fn(),
}));
vi.mock("@/server/catalog", () => service);

const categories = await import("@/app/api/v1/categories/route");
const categoryById = await import("@/app/api/v1/categories/[id]/route");
const suppliers = await import("@/app/api/v1/suppliers/route");
const supplierById = await import("@/app/api/v1/suppliers/[id]/route");
const materials = await import("@/app/api/v1/materials/route");
const materialById = await import("@/app/api/v1/materials/[id]/route");

const BASE = "http://localhost:8787";
const ID = "6f1c1e0a-2b0d-4c3e-9f5a-1b2c3d4e5f60";
const CAT_ID = "7f1c1e0a-2b0d-4c3e-9f5a-1b2c3d4e5f61";

function jsonRequest(method: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(new URL(path, BASE), {
    method,
    headers: { "content-type": "application/json", origin: BASE, ...headers },
    body: JSON.stringify(body),
  });
}
const getRequest = (path: string) => new Request(new URL(path, BASE));
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) }) as never;

function as(role: string | null, active = true) {
  if (role === null) {
    state.sub = null;
    state.profile = null;
    return;
  }
  state.sub = "actor-id";
  state.profile = { id: "actor-id", login: "actor", full_name: "Actor", role, active };
}

const VALID_MATERIAL = { code: "pr-1", name: "Profil", category_id: CAT_ID, unit: "sztanga" };

beforeEach(() => {
  as(null);
  for (const fn of Object.values(service)) fn.mockReset().mockResolvedValue({ ok: true, data: {} });
});

const serviceCalls = () => Object.values(service).reduce((n, fn) => n + fn.mock.calls.length, 0);

type Case = { name: string; allowed: string[]; call: () => Promise<Response> };

const cases: Case[] = [
  { name: "GET /categories", allowed: ["ADMIN", "BIURO", "PRODUKCJA"], call: () => categories.GET(getRequest("/api/v1/categories")) },
  {
    name: "POST /categories",
    allowed: ["ADMIN"],
    call: () => categories.POST(jsonRequest("POST", "/api/v1/categories", { name: "Okucia" })),
  },
  {
    name: "PATCH /categories/[id]",
    allowed: ["ADMIN"],
    call: () => categoryById.PATCH(jsonRequest("PATCH", "/x", { active: false }), ctx()),
  },
  { name: "GET /suppliers", allowed: ["ADMIN", "BIURO", "PRODUKCJA"], call: () => suppliers.GET(getRequest("/api/v1/suppliers")) },
  {
    name: "POST /suppliers",
    allowed: ["ADMIN", "BIURO"],
    call: () => suppliers.POST(jsonRequest("POST", "/api/v1/suppliers", { name: "ACME" })),
  },
  {
    name: "PATCH /suppliers/[id]",
    allowed: ["ADMIN", "BIURO"],
    call: () => supplierById.PATCH(jsonRequest("PATCH", "/x", { active: false }), ctx()),
  },
  { name: "GET /materials", allowed: ["ADMIN", "BIURO", "PRODUKCJA"], call: () => materials.GET(getRequest("/api/v1/materials")) },
  {
    name: "GET /materials/[id]",
    allowed: ["ADMIN", "BIURO", "PRODUKCJA"],
    call: () => materialById.GET(getRequest(`/api/v1/materials/${ID}`), ctx()),
  },
  {
    name: "POST /materials",
    allowed: ["ADMIN"],
    call: () => materials.POST(jsonRequest("POST", "/api/v1/materials", VALID_MATERIAL)),
  },
  {
    name: "PATCH /materials/[id]",
    allowed: ["ADMIN"],
    call: () => materialById.PATCH(jsonRequest("PATCH", "/x", { active: false }), ctx()),
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

  for (const role of ["ADMIN", "BIURO", "PRODUKCJA"]) {
    if (allowed.includes(role)) {
      it(`${role} → dozwolone`, async () => {
        as(role);
        const res = await call();
        expect(res.status).toBeLessThan(300);
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

  it("POST /materials: przekazuje znormalizowane dane (kod UPPERCASE)", async () => {
    const res = await materials.POST(jsonRequest("POST", "/api/v1/materials", { ...VALID_MATERIAL, name: " Profil " }));
    expect(res.status).toBe(201);
    expect(service.createMaterial).toHaveBeenCalledWith(expect.anything(), { ...VALID_MATERIAL, code: "PR-1" });
  });

  it("POST z text/plain → 415, z obcym Origin → 403, bez Origin i Sec-Fetch-Site → 403", async () => {
    const plain = await materials.POST(
      jsonRequest("POST", "/api/v1/materials", VALID_MATERIAL, { "content-type": "text/plain" }),
    );
    expect(plain.status).toBe(415);
    const evil = await materials.POST(
      jsonRequest("POST", "/api/v1/materials", VALID_MATERIAL, { origin: "https://evil.example" }),
    );
    expect(evil.status).toBe(403);
    const noOrigin = await materials.POST(
      new Request(new URL("/api/v1/materials", BASE), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(VALID_MATERIAL),
      }),
    );
    expect(noOrigin.status).toBe(403);
    expect(service.createMaterial).not.toHaveBeenCalled();
  });

  it("PATCH z text/plain → 415 (kategorie, dostawcy, materiały)", async () => {
    const headers = { "content-type": "text/plain" };
    for (const patch of [categoryById.PATCH, supplierById.PATCH, materialById.PATCH]) {
      expect((await patch(jsonRequest("PATCH", "/x", { active: false }, headers), ctx())).status).toBe(415);
    }
    expect(serviceCalls()).toBe(0);
  });

  it("niepoprawne dane → 400 VALIDATION z polami", async () => {
    const res = await materials.POST(jsonRequest("POST", "/api/v1/materials", { code: "a;b", unit: "" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION");
    expect(Object.keys(body.error.fields)).toEqual(expect.arrayContaining(["code", "name", "category_id", "unit"]));
    expect(service.createMaterial).not.toHaveBeenCalled();
  });

  it("nieznane pola (created_by, id) → 400", async () => {
    const res = await materials.POST(jsonRequest("POST", "/api/v1/materials", { ...VALID_MATERIAL, created_by: ID }));
    expect(res.status).toBe(400);
    const patch = await materialById.PATCH(jsonRequest("PATCH", "/x", { id: CAT_ID }), ctx());
    expect(patch.status).toBe(400);
    expect(serviceCalls()).toBe(0);
  });

  it("zły identyfikator w ścieżce → 400", async () => {
    expect((await materialById.PATCH(jsonRequest("PATCH", "/x", { active: false }), ctx("nie-uuid"))).status).toBe(400);
    expect((await materialById.GET(getRequest("/x"), ctx("nie-uuid"))).status).toBe(400);
    expect((await categoryById.PATCH(jsonRequest("PATCH", "/x", { active: false }), ctx("x"))).status).toBe(400);
    expect((await supplierById.PATCH(jsonRequest("PATCH", "/x", { active: false }), ctx("x"))).status).toBe(400);
    expect(serviceCalls()).toBe(0);
  });

  it("GET /materials: parametry listy walidowane (pageSize ≤ 100) i przekazywane do serwisu", async () => {
    expect((await materials.GET(getRequest("/api/v1/materials?pageSize=101"))).status).toBe(400);
    expect((await materials.GET(getRequest("/api/v1/materials?categoryId=zly"))).status).toBe(400);
    expect(service.listMaterials).not.toHaveBeenCalled();

    const res = await materials.GET(
      getRequest(`/api/v1/materials?q=abc&categoryId=${CAT_ID}&includeInactive=true&page=2&pageSize=50`),
    );
    expect(res.status).toBe(200);
    expect(service.listMaterials).toHaveBeenCalledWith(expect.anything(), {
      q: "abc",
      categoryId: CAT_ID,
      includeInactive: true,
      page: 2,
      pageSize: 50,
    });
  });

  it("błędy serwisu → status i kod (409, 400, 404)", async () => {
    for (const [status, code] of [
      [409, "CODE_TAKEN"],
      [400, "INACTIVE_CATEGORY"],
      [404, "NOT_FOUND"],
    ] as const) {
      service.updateMaterial.mockResolvedValueOnce({ ok: false, error: { status, code, message: "x" } });
      const res = await materialById.PATCH(jsonRequest("PATCH", "/x", { name: "y" }), ctx());
      expect(res.status).toBe(status);
      expect((await res.json()).error.code).toBe(code);
    }
    service.createCategory.mockResolvedValueOnce({
      ok: false,
      error: { status: 409, code: "NAME_TAKEN", message: "Kategoria o tej nazwie już istnieje" },
    });
    const dup = await categories.POST(jsonRequest("POST", "/api/v1/categories", { name: "Profile" }));
    expect(dup.status).toBe(409);
  });
});

describe("BIURO — dostawcy", () => {
  it("POST /suppliers → 201", async () => {
    as("BIURO");
    const res = await suppliers.POST(jsonRequest("POST", "/api/v1/suppliers", { name: "ACME", phone: "123" }));
    expect(res.status).toBe(201);
    expect(service.createSupplier).toHaveBeenCalledWith(expect.anything(), { name: "ACME", phone: "123" });
  });
});
