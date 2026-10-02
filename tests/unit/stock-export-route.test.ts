import { beforeEach, describe, expect, it, vi } from "vitest";

// Route handler GET /api/v1/stock/export: 401 / 403 (PRODUKCJA) / walidacja / nagłówki odpowiedzi.

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

const service = vi.hoisted(() => ({ exportStockCsv: vi.fn() }));
vi.mock("@/server/overview", () => service);

const route = await import("@/app/api/v1/stock/export/route");
const BASE = "http://localhost:8787";
const CATEGORY = "7a2d2f1b-3c1e-4d4f-8a6b-2c3d4e5f6071";
const get = (qs: string) => route.GET(new Request(new URL(`/api/v1/stock/export?${qs}`, BASE)));

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
  service.exportStockCsv.mockReset().mockResolvedValue({
    ok: true,
    data: { filename: "stany-lokalizacje_2026-10-02_1007.csv", body: "Kod;Ilość\r\n" },
  });
});

describe("GET /api/v1/stock/export", () => {
  it("niezalogowany → 401, serwis nie jest wywoływany", async () => {
    const res = await get("variant=location");
    expect(res.status).toBe(401);
    expect(service.exportStockCsv).not.toHaveBeenCalled();
  });

  it("PRODUKCJA → 403, serwis nie jest wywoływany", async () => {
    as("PRODUKCJA");
    const res = await get("variant=location");
    expect(res.status).toBe(403);
    expect(service.exportStockCsv).not.toHaveBeenCalled();
  });

  it("BIURO i ADMIN → 200 z text/csv, Content-Disposition i BOM w treści", async () => {
    for (const role of ["BIURO", "ADMIN"]) {
      as(role);
      const res = await get("variant=location");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
      expect(res.headers.get("content-disposition")).toBe('attachment; filename="stany-lokalizacje_2026-10-02_1007.csv"');
      expect(res.headers.get("cache-control")).toBe("no-store");
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      expect(new TextDecoder().decode(bytes.slice(3))).toBe("Kod;Ilość\r\n");
    }
  });

  it("filtry trafiają do serwisu", async () => {
    as("BIURO");
    await get(`variant=material&q=K518&categoryId=${CATEGORY}&belowMin=true`);
    expect(service.exportStockCsv).toHaveBeenCalledWith(expect.anything(), {
      variant: "material",
      q: "K518",
      categoryId: CATEGORY,
      belowMin: true,
    });
  });

  it("nieprawidłowy wariant / brak wariantu / zła kategoria → 400", async () => {
    as("ADMIN");
    for (const qs of ["variant=xx", "", "variant=material&categoryId=nie-uuid"]) {
      const res = await get(qs);
      expect(res.status, qs).toBe(400);
    }
    expect(service.exportStockCsv).not.toHaveBeenCalled();
  });

  it("błąd serwisu → status błędu w JSON (bez ciała CSV)", async () => {
    as("ADMIN");
    service.exportStockCsv.mockResolvedValue({ ok: false, error: { status: 500, code: "INTERNAL", message: "x" } });
    const res = await get("variant=location");
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});
