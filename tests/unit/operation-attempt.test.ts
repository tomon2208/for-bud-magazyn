import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canEdit,
  discardAttempt,
  finishSend,
  initialAttempt,
  isUnresolved,
  startSend,
  type Attempt,
} from "@/lib/operation-attempt";
import { parsePending, PENDING_MAX_AGE_MS, type PendingOperation } from "@/lib/pending-operation";
import { submitAdjustment, submitOperation, submitReversal, type IssuePayload, type ReceiptPayload } from "@/lib/stock-client";

// Wspólny mechanizm próby zapisu operacji magazynowej (przyjęcie / wydanie / przesunięcie): po wyniku nieznanym
// nie wolno wygenerować nowego id (to dublowało operację), ponowienie wysyła DOKŁADNIE to samo żądanie.

const payload = (q: number): ReceiptPayload => ({
  client_request_id: "",
  location_id: "loc",
  material_id: "mat",
  quantity: q,
});

let n = 0;
const makeId = () => `id-${++n}`;

describe("operation-attempt", () => {
  it("nowe dane → nowy id; w trakcie wysyłania kolejne wysłanie ignorowane", () => {
    const a = initialAttempt<ReceiptPayload>();
    expect(canEdit(a)).toBe(true);
    const s1 = startSend(a, payload(1), makeId)!;
    expect(s1.requestId).toMatch(/^id-/);
    expect(s1.next.status).toBe("sending");
    expect(canEdit(s1.next)).toBe(false);
    expect(startSend(s1.next, payload(1), makeId)).toBeNull(); // podwójne kliknięcie
  });

  it("błąd sieci → dane zamrożone; ponowienie = ten sam id i payload, nawet gdy przekazano inny", () => {
    const s1 = startSend(initialAttempt<ReceiptPayload>(), payload(3), makeId)!;
    const unknown = finishSend({ ...s1.next, payload: s1.payload }, "network");
    expect(unknown.status).toBe("unknown");
    expect(isUnresolved(unknown)).toBe(true);
    expect(canEdit(unknown)).toBe(false);
    const retry = startSend(unknown, payload(999), makeId)!; // użytkownik „zmienił” ilość — ignorowane
    expect(retry.requestId).toBe(s1.requestId);
    expect(retry.payload.quantity).toBe(3);
    expect(retry.next.retry).toBe(true);
  });

  it("sesja wygasła (auth) → też zamrożone i ponawiane tym samym id", () => {
    const s1 = startSend(initialAttempt<ReceiptPayload>(), payload(2), makeId)!;
    const auth = finishSend({ ...s1.next, payload: s1.payload }, "auth");
    expect(auth.status).toBe("auth");
    expect(startSend(auth, payload(5), makeId)!.requestId).toBe(s1.requestId);
  });

  it("sukces / błąd domenowy → koniec próby; kolejne dane dostają NOWY id", () => {
    for (const kind of ["ok", "error"] as const) {
      const s1 = startSend(initialAttempt<ReceiptPayload>(), payload(1), makeId)!;
      const done = finishSend(s1.next, kind);
      expect(done.status).toBe("idle");
      expect(canEdit(done)).toBe(true);
      expect(startSend(done, payload(1), makeId)!.requestId).not.toBe(s1.requestId);
    }
  });

  it("jawne porzucenie odblokowuje formularz", () => {
    const s1 = startSend(initialAttempt<ReceiptPayload>(), payload(1), makeId)!;
    const unknown: Attempt<ReceiptPayload> = finishSend(s1.next, "network");
    const d = discardAttempt<ReceiptPayload>();
    expect(isUnresolved(unknown)).toBe(true);
    expect(canEdit(d)).toBe(true);
  });

  it("ten sam mechanizm dla wydania: ponowienie zachowuje zlecenie/powód", () => {
    const issue: IssuePayload = { client_request_id: "", location_id: "l", material_id: "m", quantity: 2, production_order_id: "o1" };
    const s1 = startSend(initialAttempt<IssuePayload>(), issue, makeId)!;
    const unknown = finishSend({ ...s1.next, payload: s1.payload }, "network");
    const retry = startSend(unknown, { ...issue, production_order_id: null, reason_code: "INNY" }, makeId)!;
    expect(retry.requestId).toBe(s1.requestId);
    expect(retry.payload).toMatchObject({ production_order_id: "o1" });
    expect(retry.payload.reason_code).toBeUndefined();
  });
});

describe("parsePending (sessionStorage) — przyjęcie, wydanie, przesunięcie", () => {
  const NOW = 1_800_000_000_000;
  const material = { id: "m1", code: "K518", name: "Profil", unit: "mb", allowsFraction: true, defaultSupplierId: null };
  const loc = (id: string, code: string) => ({ id, code, name: null });
  const receipt: PendingOperation<"RECEIPT"> = {
    v: 2,
    kind: "RECEIPT",
    userId: "u1",
    requestId: "r1",
    payload: { client_request_id: "r1", location_id: "l1", material_id: "m1", quantity: 2.5 },
    ctx: { location: loc("l1", "A-01-01"), material, supplierName: null },
    savedAt: NOW - 1000,
  };
  const issueOrder: PendingOperation<"ISSUE"> = {
    v: 2,
    kind: "ISSUE",
    userId: "u1",
    requestId: "r2",
    payload: { client_request_id: "r2", location_id: "l1", material_id: "m1", quantity: 1, production_order_id: "o1", reason_code: null },
    ctx: { location: loc("l1", "A-01-01"), material, target: { kind: "order", id: "o1", name: "Kowalski" } },
    savedAt: NOW - 1000,
  };
  const issueReason: PendingOperation<"ISSUE"> = {
    ...issueOrder,
    payload: { ...issueOrder.payload, production_order_id: null, reason_code: "INNY", reason: "test" },
    ctx: { ...issueOrder.ctx, target: { kind: "reason", code: "INNY", label: "Inny", text: "test" } },
  };
  const transfer: PendingOperation<"TRANSFER"> = {
    v: 2,
    kind: "TRANSFER",
    userId: "u1",
    requestId: "r3",
    payload: { client_request_id: "r3", material_id: "m1", from_location_id: "l1", to_location_id: "l2", quantity: 4 },
    ctx: { from: loc("l1", "A-01-01"), to: loc("l2", "B-01-01"), material },
    savedAt: NOW - 1000,
  };
  const raw = (v: unknown) => JSON.stringify(v);

  it("poprawne zapisy właściciela (każdy typ)", () => {
    expect(parsePending(raw(receipt), "RECEIPT", "u1", NOW)).toEqual(receipt);
    expect(parsePending(raw(issueOrder), "ISSUE", "u1", NOW)).toEqual(issueOrder);
    expect(parsePending(raw(issueReason), "ISSUE", "u1", NOW)).toEqual(issueReason);
    expect(parsePending(raw(transfer), "TRANSFER", "u1", NOW)).toEqual(transfer);
  });

  it.each([
    ["brak", null, "RECEIPT"],
    ["zły JSON", "{", "RECEIPT"],
    ["inny użytkownik", raw({ ...receipt, userId: "u2" }), "RECEIPT"],
    ["inny typ niż oczekiwany", raw(receipt), "ISSUE"],
    ["przeterminowany", raw({ ...receipt, savedAt: NOW - PENDING_MAX_AGE_MS - 1 }), "RECEIPT"],
    ["id ≠ client_request_id", raw({ ...receipt, payload: { ...receipt.payload, client_request_id: "x" } }), "RECEIPT"],
    ["materiał ≠ payload", raw({ ...receipt, ctx: { ...receipt.ctx, material: { ...material, id: "m2" } } }), "RECEIPT"],
    ["ilość 0", raw({ ...receipt, payload: { ...receipt.payload, quantity: 0 } }), "RECEIPT"],
    ["stara wersja (v1)", raw({ ...receipt, v: 1 }), "RECEIPT"],
    ["wydanie: zlecenie w ctx ≠ payload", raw({ ...issueOrder, ctx: { ...issueOrder.ctx, target: { kind: "order", id: "o2", name: "X" } } }), "ISSUE"],
    ["wydanie: zlecenie i powód naraz", raw({ ...issueOrder, payload: { ...issueOrder.payload, reason_code: "SERWIS" } }), "ISSUE"],
    ["wydanie: powód ≠ payload", raw({ ...issueReason, payload: { ...issueReason.payload, reason_code: "SERWIS" } }), "ISSUE"],
    ["przesunięcie: dokąd ≠ payload", raw({ ...transfer, ctx: { ...transfer.ctx, to: loc("l9", "Z") } }), "TRANSFER"],
  ] as const)("%s → null", (_n, value, kind) => {
    expect(parsePending(value as string | null, kind, "u1", NOW)).toBeNull();
  });
});

describe("submitOperation — endpoint i klasyfikacja wyniku", () => {
  afterEach(() => vi.unstubAllGlobals());
  let fetchMock: ReturnType<typeof vi.fn> | null = null;
  const respond = (status: number, body: unknown) => {
    fetchMock = vi.fn(async (url: string) => (void url, new Response(JSON.stringify(body), { status })));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };
  const lastUrl = () => fetchMock?.mock.calls.at(-1)?.[0];
  const body = { ...payload(1), client_request_id: "r" };
  const adjBody = {
    client_request_id: "r",
    material_id: "m",
    location_id: "l",
    target_quantity: 3,
    expected_current: 5,
    reason_code: "ZAGINIECIE",
  };

  it("201/200 → ok; właściwy endpoint per typ", async () => {
    const f = respond(201, { data: { idempotentReplay: false } });
    expect((await submitOperation("RECEIPT", body)).kind).toBe("ok");
    await submitOperation("ISSUE", { ...body, reason_code: "SERWIS" });
    await submitOperation("TRANSFER", { client_request_id: "r", material_id: "m", from_location_id: "a", to_location_id: "b", quantity: 1 });
    expect(f.mock.calls.map((c) => c[0])).toEqual(["/api/v1/stock/receipts", "/api/v1/stock/issues", "/api/v1/stock/transfers"]);
  });
  it("brak sieci → network", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    expect((await submitOperation("ISSUE", body)).kind).toBe("network");
  });
  it("5xx → network (wynik nieznany)", async () => {
    respond(500, { error: { code: "INTERNAL" } });
    expect((await submitOperation("TRANSFER", body as never)).kind).toBe("network");
  });
  it("409 RETRY → network (ponowienie tym samym id)", async () => {
    respond(409, { error: { code: "RETRY", message: "x" } });
    expect((await submitOperation("RECEIPT", body)).kind).toBe("network");
  });
  it("409 IDEMPOTENCY_CONFLICT → error (domenowy)", async () => {
    respond(409, { error: { code: "IDEMPOTENCY_CONFLICT", message: "x" } });
    expect(await submitOperation("RECEIPT", body)).toMatchObject({ kind: "error", code: "IDEMPOTENCY_CONFLICT" });
  });
  it("409 INSUFFICIENT_STOCK → error z dostępną ilością", async () => {
    respond(409, { error: { code: "INSUFFICIENT_STOCK", message: "Dostępne: 7", details: { available: 7 } } });
    expect(await submitOperation("ISSUE", body)).toEqual({
      kind: "error",
      status: 409,
      code: "INSUFFICIENT_STOCK",
      message: "Dostępne: 7",
      available: 7,
      details: { available: 7 },
    });
  });
  it("409 STOCK_CHANGED (korekta) → error ze szczegółami; 401 korekty/storna → auth", async () => {
    respond(409, { error: { code: "STOCK_CHANGED", message: "teraz 4", details: { current: 4 } } });
    expect(await submitAdjustment(adjBody)).toEqual({
      kind: "error",
      status: 409,
      code: "STOCK_CHANGED",
      message: "teraz 4",
      details: { current: 4 },
    });
    expect(lastUrl()).toBe("/api/v1/stock/adjustments");
    respond(401, { error: { code: "UNAUTHENTICATED" } });
    expect(await submitReversal({ client_request_id: "r", operation_id: "o", reason: "abc" })).toMatchObject({
      kind: "auth",
      message: expect.stringContaining("cofnięcie"),
    });
    expect(lastUrl()).toBe("/api/v1/stock/reversals");
  });
  it("korekta: 500 / błąd sieci → wynik nieznany (ponów tym samym id)", async () => {
    respond(500, { error: { code: "INTERNAL" } });
    expect((await submitAdjustment(adjBody)).kind).toBe("network");
  });
  it("401 → auth (zachowaj do dokończenia po zalogowaniu); komunikat wg typu", async () => {
    respond(401, { error: { code: "UNAUTHENTICATED" } });
    expect(await submitOperation("ISSUE", body)).toMatchObject({ kind: "auth", message: expect.stringContaining("wydanie") });
  });
  it("400 → error z komunikatem serwera", async () => {
    respond(400, { error: { code: "NOT_INTEGER", message: "Całe sztuki" } });
    expect(await submitOperation("RECEIPT", body)).toMatchObject({ kind: "error", message: "Całe sztuki" });
  });
});
