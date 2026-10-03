import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkBarLength, createMaterialSchema, updateMaterialSchema } from "@/lib/validation/catalog";
import { importRequirementSchema, resolveCodesSchema, upsertAliasSchema } from "@/lib/validation/import";

// Route handlery importu LiczOkno (Etap 12a): 401 / 403 (PRODUKCJA bez dostępu) / CSRF / walidacja / mapowanie błędów.
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
  resolveImportCodes: vi.fn(),
  listImportAliases: vi.fn(),
  upsertImportAlias: vi.fn(),
  deleteImportAlias: vi.fn(),
  importRequirement: vi.fn(),
}));
vi.mock("@/server/import", () => service);

const resolveRoute = await import("@/app/api/v1/import/resolve/route");
const aliasesRoute = await import("@/app/api/v1/import/aliases/route");
const aliasRoute = await import("@/app/api/v1/import/aliases/[id]/route");
const requirementsRoute = await import("@/app/api/v1/import/requirements/route");
const { mapRequirementError } = await import("@/server/requirements");

const BASE = "http://localhost:8787";
const ID = "6f1c1e0a-2b0d-4c3e-9f5a-1b2c3d4e5f60";
const MAT = "7a2d2f1b-3c1e-4d4f-8a6b-2c3d4e5f6071";
const MAT2 = "8b3e3a2c-4d2f-4e5a-9b7c-3d4e5f607182";
const CRID = "9c4f4b3d-5e3a-4f6b-8c8d-4e5f60718293";
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) }) as never;
const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(new URL(path, BASE), {
    method,
    headers: { "content-type": "application/json", origin: BASE, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const importBody = {
  order_id: ID,
  name: "  Okna parter ",
  file_name: "lista.xls",
  import_format: "liczokno-lista-materialowa",
  items: [{ material_id: MAT, quantity: "2,5", raw_source_ref: "LiczOkno: A1 w. 4: 2,5 m" }],
  client_request_id: CRID,
};
const { order_id: _orderId, ...noOrder } = importBody;
void _orderId;

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
  for (const fn of Object.values(service)) fn.mockReset().mockResolvedValue({ ok: true, data: [] });
  service.importRequirement.mockResolvedValue({
    ok: true,
    data: { orderId: ID, requirementId: MAT, itemCount: 1, orderCreated: false, idempotentReplay: false },
  });
});
const serviceCalls = () => Object.values(service).reduce((n, fn) => n + fn.mock.calls.length, 0);

type Case = { name: string; call: () => Promise<Response> };
const ALLOWED = ["ADMIN", "BIURO"];
const cases: Case[] = [
  { name: "POST /import/resolve", call: () => resolveRoute.POST(send("POST", "/api/v1/import/resolve", { codes: ["A1"] })) },
  { name: "GET /import/aliases", call: () => aliasesRoute.GET() },
  { name: "PUT /import/aliases", call: () => aliasesRoute.PUT(send("PUT", "/api/v1/import/aliases", { source_code: "a1", action: "IGNORE" })) },
  { name: "DELETE /import/aliases/[id]", call: () => aliasRoute.DELETE(send("DELETE", `/api/v1/import/aliases/${ID}`), ctx()) },
  { name: "POST /import/requirements", call: () => requirementsRoute.POST(send("POST", "/api/v1/import/requirements", importBody)) },
];

describe.each(cases)("$name — uprawnienia", ({ call }) => {
  it("bez sesji → 401", async () => {
    expect((await call()).status).toBe(401);
    expect(serviceCalls()).toBe(0);
  });
  for (const role of ["ADMIN", "BIURO", "PRODUKCJA"]) {
    if (ALLOWED.includes(role)) {
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

describe("POST /import/resolve", () => {
  beforeEach(() => as("BIURO"));
  it("kody przycięte; puste, brak, > 1000 i obce pole → 400", async () => {
    await resolveRoute.POST(send("POST", "/api/v1/import/resolve", { codes: ["  A1 ", "B2"] }));
    expect(service.resolveImportCodes).toHaveBeenCalledWith(expect.anything(), { codes: ["A1", "B2"] });
    service.resolveImportCodes.mockClear();
    const tooMany = Array.from({ length: 1001 }, (_, i) => `K${i}`);
    for (const body of [{ codes: [] }, { codes: [""] }, {}, { codes: ["A"], x: 1 }, { codes: tooMany }, { codes: [5] }]) {
      expect((await resolveRoute.POST(send("POST", "/api/v1/import/resolve", body))).status).toBe(400);
    }
    expect(service.resolveImportCodes).not.toHaveBeenCalled();
    expect(resolveCodesSchema.safeParse({ codes: Array.from({ length: 1000 }, (_, i) => `K${i}`) }).success).toBe(true);
  });
  it("CSRF: obcy Origin → 403, text/plain → 415", async () => {
    const evil = { origin: "https://evil.example" };
    expect((await resolveRoute.POST(send("POST", "/api/v1/import/resolve", { codes: ["A"] }, evil))).status).toBe(403);
    expect((await resolveRoute.POST(send("POST", "/api/v1/import/resolve", { codes: ["A"] }, { "content-type": "text/plain" }))).status).toBe(415);
    expect(serviceCalls()).toBe(0);
  });
});

describe("PUT /import/aliases", () => {
  beforeEach(() => as("BIURO"));
  const put = (body: unknown) => aliasesRoute.PUT(send("PUT", "/api/v1/import/aliases", body));

  it("kod normalizowany (UPPERCASE, spacje); MAP z materiałem i IGNORE przechodzą", async () => {
    expect((await put({ source_code: " k1102   10/ar-ral7016 ", action: "MAP", material_id: MAT })).status).toBe(200);
    expect(service.upsertImportAlias).toHaveBeenLastCalledWith(expect.anything(), {
      source_code: "K1102 10/AR-RAL7016",
      action: "MAP",
      material_id: MAT,
    });
    expect((await put({ source_code: "x1", action: "IGNORE" })).status).toBe(200);
    expect(service.upsertImportAlias).toHaveBeenLastCalledWith(expect.anything(), { source_code: "X1", action: "IGNORE" });
  });

  it.each([
    ["MAP bez materiału", { source_code: "A1", action: "MAP" }],
    ["IGNORE z materiałem", { source_code: "A1", action: "IGNORE", material_id: MAT }],
    ["zły materiał", { source_code: "A1", action: "MAP", material_id: "x" }],
    ["niedozwolone znaki w kodzie", { source_code: "Ą(1)", action: "IGNORE" }],
    ["kod > 50 znaków", { source_code: "A".repeat(51), action: "IGNORE" }],
    ["zła akcja", { source_code: "A1", action: "DELETE" }],
    ["obce pole", { source_code: "A1", action: "IGNORE", x: 1 }],
  ])("%s → 400", async (_n, body) => {
    expect((await put(body)).status).toBe(400);
    expect(service.upsertImportAlias).not.toHaveBeenCalled();
  });

  it("błędy domenowe: 404, 400 MATERIAL_INACTIVE", async () => {
    service.upsertImportAlias.mockResolvedValue({ ok: false, error: { status: 404, code: "NOT_FOUND", message: "x" } });
    expect((await put({ source_code: "A1", action: "MAP", material_id: MAT })).status).toBe(404);
    service.upsertImportAlias.mockResolvedValue({ ok: false, error: { status: 400, code: "MATERIAL_INACTIVE", message: "x" } });
    expect((await put({ source_code: "A1", action: "MAP", material_id: MAT })).status).toBe(400);
  });
  it("schemat: MAP + material", () => {
    expect(upsertAliasSchema.safeParse({ source_code: "A1", action: "MAP", material_id: MAT }).success).toBe(true);
  });
});

describe("DELETE /import/aliases/[id]", () => {
  beforeEach(() => as("ADMIN"));
  it("zły identyfikator → 400; obcy Origin → 403; 404 z serwisu", async () => {
    expect((await aliasRoute.DELETE(send("DELETE", "/api/v1/import/aliases/x"), ctx("x"))).status).toBe(400);
    const evil = send("DELETE", `/api/v1/import/aliases/${ID}`, undefined, { origin: "https://evil.example" });
    expect((await aliasRoute.DELETE(evil, ctx())).status).toBe(403);
    expect(serviceCalls()).toBe(0);
    service.deleteImportAlias.mockResolvedValue({ ok: false, error: { status: 404, code: "NOT_FOUND", message: "x" } });
    expect((await aliasRoute.DELETE(send("DELETE", `/api/v1/import/aliases/${ID}`), ctx())).status).toBe(404);
  });
});

describe("POST /import/requirements", () => {
  beforeEach(() => as("BIURO"));
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    requirementsRoute.POST(send("POST", "/api/v1/import/requirements", body, headers));

  it("201; pola przycięte, ilość z przecinkiem → liczba; serwis dostaje znormalizowane dane", async () => {
    const res = await post(importBody);
    expect(res.status).toBe(201);
    expect(service.importRequirement).toHaveBeenCalledWith(expect.anything(), {
      order_id: ID,
      name: "Okna parter",
      file_name: "lista.xls",
      import_format: "liczokno-lista-materialowa",
      items: [{ material_id: MAT, quantity: 2.5, raw_source_ref: "LiczOkno: A1 w. 4: 2,5 m" }],
      client_request_id: CRID,
    });
  });

  it("powtórzenie (idempotent_replay) → 200", async () => {
    service.importRequirement.mockResolvedValue({
      ok: true,
      data: { orderId: ID, requirementId: MAT, itemCount: 1, orderCreated: false, idempotentReplay: true },
    });
    expect((await post(importBody)).status).toBe(200);
  });

  it("nowe zlecenie: nazwa i numer przycięte, pusty numer → null", async () => {
    expect((await post({ ...noOrder, new_order: { name: "  Kowalski ", number: "  " } })).status).toBe(201);
    expect(service.importRequirement.mock.calls[0][1]).toMatchObject({ new_order: { name: "Kowalski", number: null } });
  });

  const items501 = Array.from({ length: 501 }, (_, i) => ({ material_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, quantity: 1 }));
  it.each([
    ["brak zlecenia i nowego zlecenia", noOrder],
    ["oba: zlecenie i nowe zlecenie", { ...importBody, new_order: { name: "x" } }],
    ["brak client_request_id", { ...importBody, client_request_id: undefined }],
    ["zły client_request_id", { ...importBody, client_request_id: "x" }],
    ["pusta nazwa listy", { ...importBody, name: "  " }],
    ["nazwa listy > 120", { ...importBody, name: "x".repeat(121) }],
    ["brak nazwy pliku", { ...importBody, file_name: "" }],
    ["brak formatu", { ...importBody, import_format: "" }],
    ["brak pozycji", { ...importBody, items: [] }],
    ["duplikat materiału", { ...importBody, items: [{ material_id: MAT, quantity: 1 }, { material_id: MAT, quantity: 2 }] }],
    ["ilość 0", { ...importBody, items: [{ material_id: MAT, quantity: 0 }] }],
    ["4 miejsca po przecinku", { ...importBody, items: [{ material_id: MAT, quantity: "1,0001" }] }],
    ["raw_source_ref > 200", { ...importBody, items: [{ material_id: MAT, quantity: 1, raw_source_ref: "x".repeat(201) }] }],
    ["nieznane pole pozycji", { ...importBody, items: [{ material_id: MAT, quantity: 1, price: 5 }] }],
    ["nieznane pole", { ...importBody, source: "MANUAL" }],
    ["nowe zlecenie bez nazwy", { ...noOrder, new_order: { name: " " } }],
    ["nowe zlecenie: numer > 50", { ...noOrder, new_order: { name: "x", number: "n".repeat(51) } }],
    ["501 pozycji", { ...importBody, items: items501 }],
  ])("%s → 400", async (_n, body) => {
    expect((await post(body)).status).toBe(400);
    expect(service.importRequirement).not.toHaveBeenCalled();
  });

  it("500 pozycji przechodzi walidację", () => {
    expect(importRequirementSchema.safeParse({ ...importBody, items: items501.slice(0, 500) }).success).toBe(true);
  });

  it("CSRF: text/plain → 415, obcy Origin → 403", async () => {
    expect((await post(importBody, { "content-type": "text/plain" })).status).toBe(415);
    expect((await post(importBody, { origin: "https://evil.example" })).status).toBe(403);
    expect(service.importRequirement).not.toHaveBeenCalled();
  });

  it.each([
    [409, "ORDER_NOT_OPEN"],
    [409, "NUMBER_TAKEN"],
    [409, "IDEMPOTENCY_CONFLICT"],
    [404, "NOT_FOUND"],
    [400, "MATERIAL_INACTIVE"],
    [400, "NOT_INTEGER"],
  ])("błąd z serwisu %i %s przekazany", async (status, code) => {
    service.importRequirement.mockResolvedValue({ ok: false, error: { status, code, message: "x" } });
    const res = await post(importBody);
    expect(res.status).toBe(status);
    expect((await res.json()).error.code).toBe(code);
  });
});

describe("mapowanie błędów DB (import)", () => {
  it("NUMBER_TAKEN → 409, INVALID_CODE → 400, NOT_FOUND alias → 404, 42501 → 403", () => {
    expect(mapRequirementError({ code: "P0001", hint: "NUMBER_TAKEN" }, "t")).toMatchObject({ status: 409, code: "NUMBER_TAKEN" });
    expect(mapRequirementError({ code: "P0001", hint: "INVALID_CODE" }, "t")).toMatchObject({ status: 400, code: "INVALID_CODE" });
    expect(mapRequirementError({ code: "P0001", hint: "NOT_FOUND", details: "alias" }, "t")).toMatchObject({
      status: 404,
      message: "Nie znaleziono powiązania",
    });
    expect(mapRequirementError({ code: "42501" }, "t")).toMatchObject({ status: 403 });
  });
});

describe("długość sztangi w kartotece", () => {
  it("przecinek dziesiętny, spacje; pusty → null", () => {
    expect(checkBarLength("6,5")).toEqual({ ok: true, value: 6.5 });
    expect(checkBarLength(" 6 ")).toEqual({ ok: true, value: 6 });
    expect(checkBarLength("")).toEqual({ ok: true, value: null });
    expect(checkBarLength(null)).toEqual({ ok: true, value: null });
    expect(checkBarLength(20)).toEqual({ ok: true, value: 20 });
    expect(checkBarLength("0,001")).toEqual({ ok: true, value: 0.001 });
  });
  it.each(["0", "-1", "20,001", "21", "abc", "1,0001", "1,2,3"])("%s → błąd", (v) => {
    expect(checkBarLength(v).ok).toBe(false);
  });
  it("schematy materiału: pole opcjonalne, przecinek akceptowany, zakres", () => {
    const base = { code: "a1", name: "x", category_id: MAT2, unit: "szt." };
    expect(createMaterialSchema.parse(base)).not.toHaveProperty("bar_length_m");
    expect(createMaterialSchema.parse({ ...base, bar_length_m: "6,5" }).bar_length_m).toBe(6.5);
    expect(createMaterialSchema.parse({ ...base, bar_length_m: "" }).bar_length_m).toBeNull();
    expect(createMaterialSchema.safeParse({ ...base, bar_length_m: "21" }).success).toBe(false);
    expect(updateMaterialSchema.parse({ bar_length_m: null }).bar_length_m).toBeNull();
    expect(updateMaterialSchema.safeParse({ bar_length_m: "0" }).success).toBe(false);
  });
});
