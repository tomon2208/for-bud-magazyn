import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOrderSchema, listOrdersQuerySchema, orderSubLabel, updateOrderSchema } from "@/lib/validation/orders";

// Testy route handlerów /api/v1/orders (zlecenia — Etap 5). Mock sesji/profilu i serwisu: jeśli handler nie
// sprawdzi roli/CSRF/walidacji, serwis zostanie wywołany i testy polegną.

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
  listOrders: vi.fn(),
  createOrder: vi.fn(),
  updateOrder: vi.fn(),
}));
vi.mock("@/server/orders", () => service);

const orders = await import("@/app/api/v1/orders/route");
const orderById = await import("@/app/api/v1/orders/[id]/route");

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

beforeEach(() => {
  as(null);
  for (const fn of Object.values(service)) fn.mockReset().mockResolvedValue({ ok: true, data: { items: [], total: 0 } });
});

const serviceCalls = () => Object.values(service).reduce((n, fn) => n + fn.mock.calls.length, 0);

type Case = { name: string; allowed: string[]; call: () => Promise<Response> };
const ALL = ["ADMIN", "BIURO", "PRODUKCJA"];
const cases: Case[] = [
  { name: "GET /orders (PRODUKCJA wybiera zlecenie przy wydaniu)", allowed: ALL, call: () => orders.GET(getRequest("/api/v1/orders")) },
  {
    name: "POST /orders",
    allowed: ["ADMIN", "BIURO"],
    call: () => orders.POST(jsonRequest("POST", "/api/v1/orders", { name: "Kowalski" })),
  },
  {
    name: "PATCH /orders/[id]",
    allowed: ["ADMIN", "BIURO"],
    call: () => orderById.PATCH(jsonRequest("PATCH", `/api/v1/orders/${ID}`, { status: "DONE" }), ctx()),
  },
];

describe.each(cases)("$name — uprawnienia", ({ allowed, call }) => {
  it("bez sesji → 401", async () => {
    expect((await call()).status).toBe(401);
    expect(serviceCalls()).toBe(0);
  });

  it("nieaktywny → 401", async () => {
    as("BIURO", false);
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
        expect(serviceCalls()).toBe(0);
      });
    }
  }
});

describe("POST /orders", () => {
  beforeEach(() => as("BIURO"));

  it("201; nazwa przycięta, pusta notatka → null", async () => {
    const res = await orders.POST(jsonRequest("POST", "/api/v1/orders", { name: "  Kowalski ", notes: "  " }));
    expect(res.status).toBe(201);
    expect(service.createOrder).toHaveBeenCalledWith(expect.anything(), { name: "Kowalski", notes: null });
  });

  it.each([
    ["pusta nazwa", { name: "  " }],
    ["za długa nazwa", { name: "x".repeat(121) }],
    ["za długa notatka", { name: "a", notes: "x".repeat(501) }],
    ["status przy tworzeniu", { name: "a", status: "DONE" }],
    ["created_by", { name: "a", created_by: ID }],
  ])("%s → 400", async (_n, body) => {
    expect((await orders.POST(jsonRequest("POST", "/api/v1/orders", body))).status).toBe(400);
    expect(serviceCalls()).toBe(0);
  });

  it("CSRF: text/plain → 415, obcy Origin → 403", async () => {
    expect((await orders.POST(jsonRequest("POST", "/api/v1/orders", { name: "a" }, { "content-type": "text/plain" }))).status).toBe(415);
    expect((await orders.POST(jsonRequest("POST", "/api/v1/orders", { name: "a" }, { origin: "https://evil.example" }))).status).toBe(403);
    expect(serviceCalls()).toBe(0);
  });
});

describe("PATCH /orders/[id]", () => {
  beforeEach(() => as("ADMIN"));

  it("zmiana statusu (także ponowne otwarcie)", async () => {
    for (const status of ["DONE", "CANCELLED", "OPEN"]) {
      const res = await orderById.PATCH(jsonRequest("PATCH", `/api/v1/orders/${ID}`, { status }), ctx());
      expect(res.status).toBe(200);
    }
    expect(service.updateOrder).toHaveBeenLastCalledWith(expect.anything(), ID, { status: "OPEN" });
  });

  it.each([
    ["pusty patch", {}],
    ["zły status", { status: "IN_PROGRESS" }],
    ["id w body", { id: ID, name: "x" }],
  ])("%s → 400", async (_n, body) => {
    expect((await orderById.PATCH(jsonRequest("PATCH", `/api/v1/orders/${ID}`, body), ctx())).status).toBe(400);
    expect(serviceCalls()).toBe(0);
  });

  it("zły identyfikator → 400; 404 z serwisu", async () => {
    expect((await orderById.PATCH(jsonRequest("PATCH", "/api/v1/orders/x", { name: "a" }), ctx("x"))).status).toBe(400);
    service.updateOrder.mockResolvedValue({ ok: false, error: { status: 404, code: "NOT_FOUND", message: "x" } });
    expect((await orderById.PATCH(jsonRequest("PATCH", `/api/v1/orders/${ID}`, { name: "a" }), ctx())).status).toBe(404);
  });
});

describe("GET /orders — parametry", () => {
  it("status, q, strona przekazane; zły status → 400", async () => {
    as("PRODUKCJA");
    expect((await orders.GET(getRequest("/api/v1/orders?status=FOO"))).status).toBe(400);
    await orders.GET(getRequest("/api/v1/orders?status=OPEN&q=kow&pageSize=30"));
    expect(service.listOrders).toHaveBeenCalledWith(expect.anything(), { status: "OPEN", q: "kow", page: 1, pageSize: 30 });
  });
});

describe("schematy zleceń", () => {
  it("domyślne parametry listy", () => {
    expect(listOrdersQuerySchema.parse({})).toEqual({ page: 1, pageSize: 50 });
  });
  it("create/update", () => {
    expect(createOrderSchema.parse({ name: " Nowak " })).toEqual({ name: "Nowak" });
    expect(updateOrderSchema.safeParse({ notes: "" }).data).toEqual({ notes: null });
    expect(updateOrderSchema.safeParse({ name: "" }).success).toBe(false);
  });
});

describe("orderSubLabel — rozróżnienie zleceń o tej samej nazwie (M1)", () => {
  it("data z godziną (Europe/Warsaw) i notatka, skrócona", () => {
    expect(orderSubLabel({ createdAt: "2026-10-02T12:05:00Z", notes: null })).toBe("utw. 02.10.2026, 14:05");
    expect(orderSubLabel({ createdAt: "2026-10-02T12:05:00Z", notes: "okna tarasowe" })).toBe("utw. 02.10.2026, 14:05 · okna tarasowe");
    expect(orderSubLabel({ createdAt: "2026-10-02T12:05:00Z", notes: "x".repeat(70) }, 10)).toBe(`utw. 02.10.2026, 14:05 · ${"x".repeat(10)}…`);
  });
});
