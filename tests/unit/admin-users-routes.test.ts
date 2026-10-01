import { beforeEach, describe, expect, it, vi } from "vitest";

// Testy route handlerów /api/v1/admin/users: wywołujemy eksportowane GET/POST/PATCH.
// Mock sesji/profilu (jak w require-role.test.ts) + mock serwisu użytkowników — jeśli handler
// nie sprawdzi roli, serwis zostanie wywołany i testy 401/403 polegną.

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
  listUsers: vi.fn(),
  createUser: vi.fn(),
  updateUser: vi.fn(),
}));
vi.mock("@/server/users", () => service);

const { GET, POST } = await import("@/app/api/v1/admin/users/route");
const { PATCH } = await import("@/app/api/v1/admin/users/[id]/route");

const BASE = "http://localhost:8787";
const USER_ID = "6f1c1e0a-2b0d-4c3e-9f5a-1b2c3d4e5f60";
const VALID_CREATE = { login: "jan", full_name: "Jan", role: "BIURO", password: "bardzo-tajne-1" };

function jsonRequest(method: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(new URL(path, BASE), {
    method,
    headers: { "content-type": "application/json", origin: BASE, ...headers },
    body: JSON.stringify(body),
  });
}

function patchCtx(id = USER_ID) {
  return { params: Promise.resolve({ id }) } as Parameters<typeof PATCH>[1];
}

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
  service.listUsers.mockReset().mockResolvedValue({ ok: true, data: [] });
  service.createUser.mockReset().mockResolvedValue({ ok: true, data: { id: USER_ID } });
  service.updateUser.mockReset().mockResolvedValue({ ok: true, data: { id: USER_ID } });
});

const calls = {
  GET: () => GET(),
  POST: () => POST(jsonRequest("POST", "/api/v1/admin/users", VALID_CREATE)),
  PATCH: () => PATCH(jsonRequest("PATCH", `/api/v1/admin/users/${USER_ID}`, { active: false }), patchCtx()),
};

function serviceCalled() {
  return (
    service.listUsers.mock.calls.length + service.createUser.mock.calls.length + service.updateUser.mock.calls.length
  );
}

describe.each(Object.entries(calls))("%s /api/v1/admin/users", (_method, call) => {
  it("bez sesji → 401", async () => {
    const res = await call();
    expect(res.status).toBe(401);
    expect(serviceCalled()).toBe(0);
  });

  it("nieaktywny ADMIN → 401", async () => {
    as("ADMIN", false);
    expect((await call()).status).toBe(401);
    expect(serviceCalled()).toBe(0);
  });

  it.each(["BIURO", "PRODUKCJA"])("rola %s → 403", async (role) => {
    as(role);
    const res = await call();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(serviceCalled()).toBe(0);
  });

  it("ADMIN → wywołuje serwis", async () => {
    as("ADMIN");
    const res = await call();
    expect(res.status).toBeLessThan(300);
    expect(serviceCalled()).toBe(1);
  });
});

describe("walidacja i CSRF w handlerach (ADMIN)", () => {
  beforeEach(() => as("ADMIN"));

  it("POST: przekazuje do serwisu znormalizowane dane", async () => {
    const res = await POST(jsonRequest("POST", "/api/v1/admin/users", { ...VALID_CREATE, login: " JAN " }));
    expect(res.status).toBe(201);
    expect(service.createUser).toHaveBeenCalledWith({ ...VALID_CREATE, login: "jan" });
  });

  it("POST z text/plain → 415", async () => {
    const res = await POST(jsonRequest("POST", "/api/v1/admin/users", VALID_CREATE, { "content-type": "text/plain" }));
    expect(res.status).toBe(415);
    expect(service.createUser).not.toHaveBeenCalled();
  });

  it("POST z obcym Origin → 403", async () => {
    const res = await POST(
      jsonRequest("POST", "/api/v1/admin/users", VALID_CREATE, { origin: "https://evil.example" }),
    );
    expect(res.status).toBe(403);
    expect(service.createUser).not.toHaveBeenCalled();
  });

  it("POST z niepoprawnymi danymi → 400 VALIDATION z polami", async () => {
    const res = await POST(jsonRequest("POST", "/api/v1/admin/users", { login: "x" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION");
    expect(Object.keys(body.error.fields)).toEqual(expect.arrayContaining(["login", "password", "role"]));
  });

  it("PATCH: zły id → 400, nieznane pole → 400, serwis nie wywołany", async () => {
    expect((await PATCH(jsonRequest("PATCH", "/x", { active: false }), patchCtx("nie-uuid"))).status).toBe(400);
    expect((await PATCH(jsonRequest("PATCH", "/x", { login: "hack" }), patchCtx())).status).toBe(400);
    expect(service.updateUser).not.toHaveBeenCalled();
  });

  it("PATCH: przekazuje id aktora do serwisu (ochrona przed samodegradacją)", async () => {
    await PATCH(jsonRequest("PATCH", "/x", { role: "BIURO" }), patchCtx());
    expect(service.updateUser).toHaveBeenCalledWith("actor-id", USER_ID, { role: "BIURO" });
  });

  it("błąd serwisu → status i kod z serwisu", async () => {
    service.updateUser.mockResolvedValue({
      ok: false,
      error: { status: 409, code: "LAST_ADMIN", message: "x" },
    });
    const res = await PATCH(jsonRequest("PATCH", "/x", { active: false }), patchCtx());
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("LAST_ADMIN");
  });
});
