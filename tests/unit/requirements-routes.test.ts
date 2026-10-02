import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRequirementSchema,
  shortagesQuerySchema,
  withdrawRequirementSchema,
} from "@/lib/validation/requirements";

// Route handlery zapotrzebowania i braków (Etap 8–10): 401 / 403 (PRODUKCJA nie tworzy list) / CSRF / walidacja.
// Serwis zamockowany — jeśli handler nie sprawdzi roli/CSRF/walidacji, serwis zostanie wywołany i test polegnie.

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
  listRequirements: vi.fn(),
  createRequirement: vi.fn(),
  withdrawRequirement: vi.fn(),
  getOrderShortages: vi.fn(),
  getOrderToIssue: vi.fn(),
  listShortages: vi.fn(),
  exportShortagesCsv: vi.fn(),
}));
vi.mock("@/server/requirements", () => service);

const reqRoute = await import("@/app/api/v1/orders/[id]/requirements/route");
const shortRoute = await import("@/app/api/v1/orders/[id]/shortages/route");
const toIssueRoute = await import("@/app/api/v1/orders/[id]/to-issue/route");
const withdrawRoute = await import("@/app/api/v1/requirements/[id]/withdraw/route");
const summaryRoute = await import("@/app/api/v1/shortages/route");
const exportRoute = await import("@/app/api/v1/shortages/export/route");

const BASE = "http://localhost:8787";
const ID = "6f1c1e0a-2b0d-4c3e-9f5a-1b2c3d4e5f60";
const MAT = "7a2d2f1b-3c1e-4d4f-8a6b-2c3d4e5f6071";
const MAT2 = "8b3e3a2c-4d2f-4e5a-9b7c-3d4e5f607182";
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) }) as never;
const getRequest = (path: string) => new Request(new URL(path, BASE));
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(new URL(path, BASE), {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, ...headers },
    body: JSON.stringify(body),
  });
const validBody = { name: "  Okna parter ", items: [{ material_id: MAT, quantity: "2,5" }] };

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
    fn.mockReset().mockResolvedValue({ ok: true, data: { filename: "braki_x.csv", body: "Dostawca;Kod\r\n" } });
  }
});
const serviceCalls = () => Object.values(service).reduce((n, fn) => n + fn.mock.calls.length, 0);

type Case = { name: string; allowed: string[]; call: () => Promise<Response> };
const ALL = ["ADMIN", "BIURO", "PRODUKCJA"];
const cases: Case[] = [
  { name: "GET /orders/[id]/requirements", allowed: ALL, call: () => reqRoute.GET(getRequest(`/api/v1/orders/${ID}/requirements`), ctx()) },
  {
    name: "POST /orders/[id]/requirements",
    allowed: ["ADMIN", "BIURO"],
    call: () => reqRoute.POST(post(`/api/v1/orders/${ID}/requirements`, validBody), ctx()),
  },
  {
    name: "POST /requirements/[id]/withdraw",
    allowed: ["ADMIN", "BIURO"],
    call: () => withdrawRoute.POST(post(`/api/v1/requirements/${ID}/withdraw`, { reason: "zła ilość" }), ctx()),
  },
  { name: "GET /orders/[id]/shortages", allowed: ["ADMIN", "BIURO"], call: () => shortRoute.GET(getRequest(`/api/v1/orders/${ID}/shortages`), ctx()) },
  { name: "GET /orders/[id]/to-issue", allowed: ["ADMIN", "PRODUKCJA"], call: () => toIssueRoute.GET(getRequest(`/api/v1/orders/${ID}/to-issue`), ctx()) },
  { name: "GET /shortages", allowed: ["ADMIN", "BIURO"], call: () => summaryRoute.GET(getRequest("/api/v1/shortages")) },
  { name: "GET /shortages/export", allowed: ["ADMIN", "BIURO"], call: () => exportRoute.GET(getRequest("/api/v1/shortages/export")) },
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
        expect(serviceCalls()).toBe(1);
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

describe("POST /orders/[id]/requirements", () => {
  beforeEach(() => as("BIURO"));

  it("201; nazwa przycięta, ilość z przecinkiem → liczba; serwis dostaje id zlecenia", async () => {
    service.createRequirement.mockResolvedValue({ ok: true, data: { requirementId: ID, itemCount: 1, idempotentReplay: false } });
    const res = await reqRoute.POST(post(`/api/v1/orders/${ID}/requirements`, validBody), ctx());
    expect(res.status).toBe(201);
    expect(service.createRequirement).toHaveBeenCalledWith(expect.anything(), ID, {
      name: "Okna parter",
      items: [{ material_id: MAT, quantity: 2.5 }],
    });
  });

  it("powtórzenie (idempotent_replay) → 200", async () => {
    service.createRequirement.mockResolvedValue({ ok: true, data: { requirementId: ID, itemCount: 1, idempotentReplay: true } });
    expect((await reqRoute.POST(post(`/api/v1/orders/${ID}/requirements`, validBody), ctx())).status).toBe(200);
  });

  it.each([
    ["pusta nazwa", { ...validBody, name: "  " }],
    ["brak pozycji", { name: "a", items: [] }],
    ["duplikat materiału", { name: "a", items: [{ material_id: MAT, quantity: 1 }, { material_id: MAT, quantity: 2 }] }],
    ["ilość 0", { name: "a", items: [{ material_id: MAT, quantity: 0 }] }],
    ["ilość ujemna", { name: "a", items: [{ material_id: MAT, quantity: "-1" }] }],
    ["4 miejsca po przecinku", { name: "a", items: [{ material_id: MAT, quantity: "1,0001" }] }],
    ["zły materiał", { name: "a", items: [{ material_id: "x", quantity: 1 }] }],
    ["nieznane pole pozycji", { name: "a", items: [{ material_id: MAT, quantity: 1, price: 5 }] }],
    ["nieznane pole listy", { ...validBody, status: "WITHDRAWN" }],
    ["za długa nazwa", { ...validBody, name: "x".repeat(121) }],
    ["501 pozycji", { name: "a", items: Array.from({ length: 501 }, (_, i) => ({ material_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, quantity: 1 })) }],
  ])("%s → 400", async (_n, body) => {
    expect((await reqRoute.POST(post(`/api/v1/orders/${ID}/requirements`, body), ctx())).status).toBe(400);
    expect(serviceCalls()).toBe(0);
  });

  it("500 pozycji przechodzi walidację", () => {
    const items = Array.from({ length: 500 }, (_, i) => ({ material_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, quantity: 1 }));
    expect(createRequirementSchema.safeParse({ name: "a", items }).success).toBe(true);
  });

  it("CSRF: text/plain → 415, obcy Origin → 403; zły identyfikator zlecenia → 400", async () => {
    const p = `/api/v1/orders/${ID}/requirements`;
    expect((await reqRoute.POST(post(p, validBody, { "content-type": "text/plain" }), ctx())).status).toBe(415);
    expect((await reqRoute.POST(post(p, validBody, { origin: "https://evil.example" }), ctx())).status).toBe(403);
    expect((await reqRoute.POST(post("/api/v1/orders/x/requirements", validBody), ctx("x"))).status).toBe(400);
    expect(serviceCalls()).toBe(0);
  });

  it("błędy domenowe z serwisu: 409 ORDER_NOT_OPEN, 404", async () => {
    service.createRequirement.mockResolvedValue({ ok: false, error: { status: 409, code: "ORDER_NOT_OPEN", message: "x" } });
    expect((await reqRoute.POST(post(`/api/v1/orders/${ID}/requirements`, validBody), ctx())).status).toBe(409);
    service.createRequirement.mockResolvedValue({ ok: false, error: { status: 404, code: "NOT_FOUND", message: "x" } });
    expect((await reqRoute.POST(post(`/api/v1/orders/${ID}/requirements`, validBody), ctx())).status).toBe(404);
  });
});

describe("POST /requirements/[id]/withdraw", () => {
  beforeEach(() => as("BIURO"));

  it("powód przycięty; 400 przy krótkim / długim / brakującym / dodatkowym polu", async () => {
    const path = `/api/v1/requirements/${ID}/withdraw`;
    expect((await withdrawRoute.POST(post(path, { reason: "  zła ilość " }), ctx())).status).toBe(200);
    expect(service.withdrawRequirement).toHaveBeenCalledWith(expect.anything(), ID, { reason: "zła ilość" });
    for (const body of [{ reason: "ab" }, { reason: "x".repeat(201) }, {}, { reason: "zła ilość", status: "ACTIVE" }]) {
      expect((await withdrawRoute.POST(post(path, body), ctx())).status).toBe(400);
    }
    expect(service.withdrawRequirement).toHaveBeenCalledTimes(1);
  });

  it("409 ALREADY_WITHDRAWN z serwisu; CSRF", async () => {
    service.withdrawRequirement.mockResolvedValue({ ok: false, error: { status: 409, code: "ALREADY_WITHDRAWN", message: "x" } });
    const path = `/api/v1/requirements/${ID}/withdraw`;
    expect((await withdrawRoute.POST(post(path, { reason: "pomyłka" }), ctx())).status).toBe(409);
    expect((await withdrawRoute.POST(post(path, { reason: "pomyłka" }, { origin: "https://evil.example" }), ctx())).status).toBe(403);
  });
});

describe("GET /shortages — parametry", () => {
  it("filtry trafiają do serwisu; zły identyfikator dostawcy → 400", async () => {
    as("BIURO");
    expect((await summaryRoute.GET(getRequest("/api/v1/shortages?supplier=x"))).status).toBe(400);
    await summaryRoute.GET(getRequest(`/api/v1/shortages?supplier=${ID}&category=${MAT2}&onlyShort=true`));
    expect(service.listShortages).toHaveBeenCalledWith(expect.anything(), { supplier: ID, category: MAT2, onlyShort: true });
    await summaryRoute.GET(getRequest("/api/v1/shortages"));
    expect(service.listShortages).toHaveBeenLastCalledWith(expect.anything(), { onlyShort: false });
  });

  it("eksport: text/csv z BOM, Content-Disposition, no-store", async () => {
    as("ADMIN");
    const res = await exportRoute.GET(getRequest("/api/v1/shortages/export?onlyShort=1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="braki_x.csv"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(service.exportShortagesCsv).toHaveBeenCalledWith(expect.anything(), { onlyShort: true });
  });

  it("eksport: błąd serwisu (400 za dużo wierszy) → JSON z błędem zamiast pliku", async () => {
    as("BIURO");
    service.exportShortagesCsv.mockResolvedValue({ ok: false, error: { status: 400, code: "TOO_MANY_ROWS", message: "zawęź" } });
    const res = await exportRoute.GET(getRequest("/api/v1/shortages/export"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("TOO_MANY_ROWS");
  });
});

describe("schematy zapotrzebowania", () => {
  it("withdraw: powód 3–200", () => {
    expect(withdrawRequirementSchema.safeParse({ reason: "abc" }).success).toBe(true);
    expect(withdrawRequirementSchema.safeParse({ reason: "ab" }).success).toBe(false);
  });
  it("shortages query: bool jako true/1", () => {
    expect(shortagesQuerySchema.parse({ onlyShort: "1" })).toEqual({ onlyShort: true });
    expect(shortagesQuerySchema.parse({})).toEqual({ onlyShort: false });
    expect(shortagesQuerySchema.safeParse({ onlyShort: "tak" }).success).toBe(false);
  });
  it("notatka pozycji: pusta → null, > 200 → błąd", () => {
    const ok = createRequirementSchema.parse({ name: "a", items: [{ material_id: MAT, quantity: 1, note: "  " }] });
    expect(ok.items[0].note).toBeNull();
    expect(createRequirementSchema.safeParse({ name: "a", items: [{ material_id: MAT, quantity: 1, note: "x".repeat(201) }] }).success).toBe(false);
  });
});
