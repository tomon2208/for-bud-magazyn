import { beforeEach, describe, expect, it, vi } from "vitest";
import { excessAfterWithdraw, releaseSchema, reserveSchema, suggestReserveQuantity } from "@/lib/validation/reservations";
import { reservationShortfallAfterAdjust } from "@/lib/adjustment";
import { issueSchema } from "@/lib/validation/stock";
import { issueLimit, suggestIssueQuantity } from "@/lib/to-issue";

// Etap 11 (ADR 014): walidacja rezerwacji i override wydania, route handlery (role, CSRF, 403 override nie-ADMIN,
// 409 RESERVED_STOCK z detalami), podpowiedzi ilości. Serwisy zamockowane.

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

const reservationService = vi.hoisted(() => ({
  reserveForOrder: vi.fn(),
  releaseReservation: vi.fn(),
  getOrderReservations: vi.fn(),
  getMaterialAvailability: vi.fn(),
  releaseReservationExcess: vi.fn(),
}));
vi.mock("@/server/reservations", () => reservationService);

const stockService = vi.hoisted(() => ({ createIssue: vi.fn() }));
vi.mock("@/server/stock", () => stockService);

const reserveRoute = await import("@/app/api/v1/orders/[id]/reservations/route");
const releaseRoute = await import("@/app/api/v1/orders/[id]/reservations/release/route");
const availabilityRoute = await import("@/app/api/v1/stock/availability/route");
const excessRoute = await import("@/app/api/v1/orders/[id]/reservations/release-excess/route");
const issuesRoute = await import("@/app/api/v1/stock/issues/route");
const { reservedStock } = await vi.importActual<typeof import("@/server/stock")>("@/server/stock");

const BASE = "http://localhost:8787";
const ID = "6f1c1e0a-2b0d-4c3e-9f5a-1b2c3d4e5f60";
const MAT = "7a2d2f1b-3c1e-4d4f-8a6b-2c3d4e5f6071";
const LOC = "9c4f4b3d-5e3a-4f6b-8c8d-4e5f60718293";
const CRID = "0b8f8a3e-4a4c-4c86-9a43-0f0f7e1d2c3b";
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) }) as never;
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
  vi.clearAllMocks();
  as(null);
});

describe("walidacja", () => {
  it("reserve: items opcjonalne (auto), ilość z przecinkiem, duplikaty i .strict()", () => {
    expect(reserveSchema.safeParse({ client_request_id: CRID }).success).toBe(true);
    const ok = reserveSchema.safeParse({ client_request_id: CRID, items: [{ material_id: MAT, quantity: "2,5" }] });
    expect(ok.success && ok.data.items?.[0].quantity).toBe(2.5);
    expect(reserveSchema.safeParse({ client_request_id: CRID, items: [] }).success).toBe(false);
    expect(
      reserveSchema.safeParse({ client_request_id: CRID, items: [{ material_id: MAT, quantity: 1 }, { material_id: MAT, quantity: 2 }] }).success,
    ).toBe(false);
    expect(reserveSchema.safeParse({ client_request_id: CRID, extra: 1 }).success).toBe(false);
    expect(reserveSchema.safeParse({ items: null }).success).toBe(false);
  });

  it("release: ilość tylko z materiałem; powód ≤ 200, pusty → null", () => {
    expect(releaseSchema.safeParse({ client_request_id: CRID }).success).toBe(true);
    expect(releaseSchema.safeParse({ client_request_id: CRID, quantity: 1 }).success).toBe(false);
    const r = releaseSchema.safeParse({ client_request_id: CRID, material_id: MAT, quantity: "1,5", reason: "  " });
    expect(r.success && r.data).toMatchObject({ quantity: 1.5, reason: null });
    expect(releaseSchema.safeParse({ client_request_id: CRID, reason: "x".repeat(201) }).success).toBe(false);
  });

  it("wydanie: override wymaga powodu ≥ 3 znaki; powód bez override odrzucony", () => {
    const base = { client_request_id: CRID, location_id: LOC, material_id: MAT, quantity: 1, reason_code: "SERWIS" };
    expect(issueSchema.safeParse({ ...base, override_reservations: true }).success).toBe(false);
    expect(issueSchema.safeParse({ ...base, override_reservations: true, override_reason: " ab " }).success).toBe(false);
    expect(issueSchema.safeParse({ ...base, override_reason: "pilne" }).success).toBe(false);
    const ok = issueSchema.safeParse({ ...base, override_reservations: true, override_reason: " pilny serwis " });
    expect(ok.success && ok.data.override_reason).toBe("pilny serwis");
    expect(issueSchema.safeParse(base).success).toBe(true);
  });
});

describe("podpowiedzi ilości", () => {
  it("suggestReserveQuantity = min(do zarezerwowania, wolne), całkowita bez ułamków, ≥ 0", () => {
    expect(suggestReserveQuantity(5, 3, false)).toBe(3);
    expect(suggestReserveQuantity(2.5, 10, true)).toBe(2.5);
    expect(suggestReserveQuantity(2.5, 10, false)).toBe(2);
    expect(suggestReserveQuantity(4, 0, true)).toBe(0);
    expect(suggestReserveQuantity(-1, 5, true)).toBe(0);
  });

  it("suggestIssueQuantity uwzględnia dostępne dla zlecenia (wolne + rezerwacja)", () => {
    const view = { kind: "ok" as const, items: [{ materialId: "m1", remaining: 12, available: 4 }] };
    expect(suggestIssueQuantity(view, "m1", 10)).toBe(4);
    expect(suggestIssueQuantity({ kind: "ok", items: [{ materialId: "m1", remaining: 12, available: 0 }] }, "m1", 10)).toBeNull();
    expect(suggestIssueQuantity({ kind: "ok", items: [{ materialId: "m1", remaining: 3, available: 8 }] }, "m1", 10)).toBe(3);
  });

  it("issueLimit = min(lokalizacja, dostępne do wydania); nieznana dostępność → lokalizacja", () => {
    expect(issueLimit(10, 4)).toBe(4);
    expect(issueLimit(3, 8)).toBe(3);
    expect(issueLimit(5, null)).toBe(5);
    expect(issueLimit(5, -1)).toBe(0);
  });
});

describe("RESERVED_STOCK — mapowanie błędu", () => {
  it("409 z detalami i czytelnym komunikatem (wolne, rezerwacja zlecenia, inne zlecenia)", () => {
    const e = reservedStock(
      JSON.stringify({ free: 1.5, own_reserved: 2, reserved_others: 6, orders: [{ order_id: ID, number: "Z-1", name: "Kowalski", quantity: 6 }] }),
    );
    expect(e).toMatchObject({ status: 409, code: "RESERVED_STOCK", details: { available: 3.5, free: 1.5, ownReserved: 2, reservedOthers: 6 } });
    expect(e.message).toContain("Można wydać: 3,5");
    expect(e.message).toContain("Z-1 Kowalski (6)");
    const broken = reservedStock("nie-json");
    expect(broken).toMatchObject({ status: 409, code: "RESERVED_STOCK", details: { available: 0 } });
  });
});

describe("route handlery rezerwacji", () => {
  it("POST /orders/[id]/reservations: 401, 403 PRODUKCJA, CSRF, walidacja; BIURO 201 / replay 200", async () => {
    expect((await reserveRoute.POST(post(`/api/v1/orders/${ID}/reservations`, { client_request_id: CRID }), ctx())).status).toBe(401);
    as("PRODUKCJA");
    expect((await reserveRoute.POST(post(`/api/v1/orders/${ID}/reservations`, { client_request_id: CRID }), ctx())).status).toBe(403);
    as("BIURO");
    expect((await reserveRoute.POST(post(`/api/v1/orders/${ID}/reservations`, { client_request_id: CRID }, { origin: "https://evil.example" }), ctx())).status).toBe(403);
    expect((await reserveRoute.POST(post(`/api/v1/orders/${ID}/reservations`, { client_request_id: "x" }), ctx())).status).toBe(400);
    expect((await reserveRoute.POST(post(`/api/v1/orders/nie-uuid/reservations`, { client_request_id: CRID }), ctx("nie-uuid"))).status).toBe(400);
    expect(reservationService.reserveForOrder).not.toHaveBeenCalled();

    reservationService.reserveForOrder.mockResolvedValueOnce({ ok: true, data: { reserved: [], notReserved: [], idempotentReplay: false } });
    expect((await reserveRoute.POST(post(`/api/v1/orders/${ID}/reservations`, { client_request_id: CRID }), ctx())).status).toBe(201);
    reservationService.reserveForOrder.mockResolvedValueOnce({ ok: true, data: { reserved: [], notReserved: [], idempotentReplay: true } });
    expect((await reserveRoute.POST(post(`/api/v1/orders/${ID}/reservations`, { client_request_id: CRID }), ctx())).status).toBe(200);
    reservationService.reserveForOrder.mockResolvedValueOnce({
      ok: false,
      error: { status: 409, code: "RESERVE_EXCEEDS_FREE", message: "x", details: { free: 2 } },
    });
    const res = await reserveRoute.POST(post(`/api/v1/orders/${ID}/reservations`, { client_request_id: CRID, items: [{ material_id: MAT, quantity: 3 }] }), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "RESERVE_EXCEEDS_FREE", details: { free: 2 } } });
  });

  it("GET /orders/[id]/reservations: PRODUKCJA 403; ADMIN 200", async () => {
    as("PRODUKCJA");
    expect((await reserveRoute.GET(new Request(new URL(`/api/v1/orders/${ID}/reservations`, BASE)), ctx())).status).toBe(403);
    as("ADMIN");
    reservationService.getOrderReservations.mockResolvedValueOnce({ ok: true, data: { items: [], events: [] } });
    expect((await reserveRoute.GET(new Request(new URL(`/api/v1/orders/${ID}/reservations`, BASE)), ctx())).status).toBe(200);
  });

  it("POST /orders/[id]/reservations/release: PRODUKCJA 403, ilość bez materiału 400, BIURO 201", async () => {
    as("PRODUKCJA");
    expect((await releaseRoute.POST(post(`/api/v1/orders/${ID}/reservations/release`, { client_request_id: CRID }), ctx())).status).toBe(403);
    as("BIURO");
    expect((await releaseRoute.POST(post(`/api/v1/orders/${ID}/reservations/release`, { client_request_id: CRID, quantity: 1 }), ctx())).status).toBe(400);
    reservationService.releaseReservation.mockResolvedValueOnce({ ok: true, data: { released: [], idempotentReplay: false } });
    expect((await releaseRoute.POST(post(`/api/v1/orders/${ID}/reservations/release`, { client_request_id: CRID }), ctx())).status).toBe(201);
  });

  it("GET /stock/availability: każda zalogowana rola; materialId wymagany", async () => {
    expect((await availabilityRoute.GET(new Request(new URL(`/api/v1/stock/availability?materialId=${MAT}`, BASE)))).status).toBe(401);
    as("PRODUKCJA");
    expect((await availabilityRoute.GET(new Request(new URL(`/api/v1/stock/availability`, BASE)))).status).toBe(400);
    reservationService.getMaterialAvailability.mockResolvedValueOnce({ ok: true, data: { free: 1 } });
    const res = await availabilityRoute.GET(new Request(new URL(`/api/v1/stock/availability?materialId=${MAT}&orderId=${ID}`, BASE)));
    expect(res.status).toBe(200);
    expect(reservationService.getMaterialAvailability).toHaveBeenCalledWith(expect.anything(), MAT, ID);
  });
});

describe("POST /stock/issues — override rezerwacji", () => {
  const body = {
    client_request_id: CRID,
    location_id: LOC,
    material_id: MAT,
    quantity: 2,
    reason_code: "SERWIS",
    override_reservations: true,
    override_reason: "pilny serwis",
  };

  it("PRODUKCJA z override → 403 bez wywołania serwisu; ADMIN → serwis z parametrami", async () => {
    as("PRODUKCJA");
    const res = await issuesRoute.POST(post("/api/v1/stock/issues", body));
    expect(res.status).toBe(403);
    expect(stockService.createIssue).not.toHaveBeenCalled();

    as("ADMIN");
    stockService.createIssue.mockResolvedValueOnce({ ok: true, data: { idempotentReplay: false } });
    expect((await issuesRoute.POST(post("/api/v1/stock/issues", body))).status).toBe(201);
    expect(stockService.createIssue.mock.calls[0][1]).toMatchObject({ override_reservations: true, override_reason: "pilny serwis" });
  });

  it("409 RESERVED_STOCK z detalami trafia do klienta", async () => {
    as("PRODUKCJA");
    stockService.createIssue.mockResolvedValueOnce({
      ok: false,
      error: { status: 409, code: "RESERVED_STOCK", message: "zarezerwowane", details: { available: 1, free: 1, ownReserved: 0, reservedOthers: 5, orders: [] } },
    });
    const { override_reservations: _o, override_reason: _r, ...plain } = body;
    void _o;
    void _r;
    const res = await issuesRoute.POST(post("/api/v1/stock/issues", plain));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "RESERVED_STOCK", details: { available: 1, reservedOthers: 5 } } });
  });
});

describe("review Etapu 11", () => {
  it("excessAfterWithdraw: nadmiar = zarezerwowane − max(potrzebne − lista − wydano, 0)", () => {
    const res = [{ materialId: "m1", materialCode: "K1", unit: "szt.", reserved: 10, needed: 10, issued: 0 }];
    expect(excessAfterWithdraw({ items: [{ materialId: "m1", quantity: 6 }] }, res)).toEqual(["K1: 6 szt."]);
    expect(excessAfterWithdraw({ items: [{ materialId: "m1", quantity: 6 }] }, [{ ...res[0], reserved: 4 }])).toEqual([]);
    expect(excessAfterWithdraw({ items: [{ materialId: "m1", quantity: 6 }] }, [{ ...res[0], reserved: 5, issued: 2 }])).toEqual(["K1: 3 szt."]);
    expect(excessAfterWithdraw({ items: [{ materialId: "inny", quantity: 6 }] }, res)).toEqual([]);
  });

  it("reservationShortfallAfterAdjust: ostrzeżenie tylko przy korekcie w dół, gdy rezerwacje > stan po korekcie", () => {
    expect(reservationShortfallAfterAdjust({ stockActive: 10, reservedTotal: 8 }, -3, true)).toBe(1);
    expect(reservationShortfallAfterAdjust({ stockActive: 10, reservedTotal: 8 }, -2, true)).toBe(0);
    expect(reservationShortfallAfterAdjust({ stockActive: 10, reservedTotal: 8 }, 5, true)).toBe(0);
    expect(reservationShortfallAfterAdjust({ stockActive: 10, reservedTotal: 12 }, -1, false)).toBe(2);
    expect(reservationShortfallAfterAdjust(null, -5, true)).toBe(0);
  });

  it("POST /orders/[id]/reservations/release-excess: PRODUKCJA 403, zły body 400, BIURO 201", async () => {
    as("PRODUKCJA");
    expect((await excessRoute.POST(post(`/api/v1/orders/${ID}/reservations/release-excess`, { client_request_id: CRID }), ctx())).status).toBe(403);
    as("BIURO");
    expect((await excessRoute.POST(post(`/api/v1/orders/${ID}/reservations/release-excess`, { client_request_id: CRID, x: 1 }), ctx())).status).toBe(400);
    reservationService.releaseReservationExcess.mockResolvedValueOnce({ ok: true, data: { released: [], idempotentReplay: false } });
    expect((await excessRoute.POST(post(`/api/v1/orders/${ID}/reservations/release-excess`, { client_request_id: CRID }), ctx())).status).toBe(201);
    expect(reservationService.releaseReservationExcess).toHaveBeenCalledWith(expect.anything(), ID, CRID);
  });
});
