import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePending, PENDING_MAX_AGE_MS, type PendingReceipt } from "@/lib/pending-receipt";
import {
  canEdit,
  discardAttempt,
  finishSend,
  initialAttempt,
  isUnresolved,
  startSend,
  type Attempt,
} from "@/lib/receipt-attempt";
import { submitReceipt, type ReceiptPayload } from "@/lib/stock-client";

// M1/M4/L1/L2: cykl próby zapisu przyjęcia — po wyniku nieznanym nie wolno wygenerować nowego id
// (to dublowało przyjęcie na desktopie), ponowienie wysyła DOKŁADNIE to samo żądanie.

const payload = (q: number): ReceiptPayload => ({
  client_request_id: "",
  location_id: "loc",
  material_id: "mat",
  quantity: q,
});

let n = 0;
const makeId = () => `id-${++n}`;

describe("receipt-attempt", () => {
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
});

describe("parsePending (sessionStorage)", () => {
  const NOW = 1_800_000_000_000;
  const valid: PendingReceipt = {
    v: 1,
    userId: "u1",
    requestId: "r1",
    payload: { client_request_id: "r1", location_id: "l1", material_id: "m1", quantity: 2.5 },
    location: { id: "l1", code: "A-01-01", name: null },
    material: { id: "m1", code: "K518", name: "Profil", unit: "mb", allowsFraction: true, defaultSupplierId: null },
    supplierName: null,
    savedAt: NOW - 1000,
  };
  const raw = (v: unknown) => JSON.stringify(v);

  it("poprawny zapis właściciela", () => {
    expect(parsePending(raw(valid), "u1", NOW)).toEqual(valid);
  });

  it.each([
    ["brak", null],
    ["zły JSON", "{"],
    ["inny użytkownik", raw({ ...valid, userId: "u2" })],
    ["przeterminowany", raw({ ...valid, savedAt: NOW - PENDING_MAX_AGE_MS - 1 })],
    ["id ≠ client_request_id", raw({ ...valid, payload: { ...valid.payload, client_request_id: "x" } })],
    ["materiał ≠ payload", raw({ ...valid, material: { ...valid.material, id: "m2" } })],
    ["ilość 0", raw({ ...valid, payload: { ...valid.payload, quantity: 0 } })],
    ["zła wersja", raw({ ...valid, v: 2 })],
  ])("%s → null", (_n, value) => {
    expect(parsePending(value as string | null, "u1", NOW)).toBeNull();
  });
});

describe("submitReceipt — klasyfikacja wyniku (L1, L2)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const respond = (status: number, body: unknown) =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
  const body = { ...payload(1), client_request_id: "r" };

  it("201/200 → ok", async () => {
    respond(201, { data: { idempotentReplay: false } });
    expect((await submitReceipt(body)).kind).toBe("ok");
  });
  it("brak sieci → network", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    expect((await submitReceipt(body)).kind).toBe("network");
  });
  it("5xx → network (wynik nieznany)", async () => {
    respond(500, { error: { code: "INTERNAL" } });
    expect((await submitReceipt(body)).kind).toBe("network");
  });
  it("409 RETRY → network (ponowienie tym samym id)", async () => {
    respond(409, { error: { code: "RETRY", message: "x" } });
    expect((await submitReceipt(body)).kind).toBe("network");
  });
  it("409 IDEMPOTENCY_CONFLICT → error (domenowy)", async () => {
    respond(409, { error: { code: "IDEMPOTENCY_CONFLICT", message: "x" } });
    expect(await submitReceipt(body)).toMatchObject({ kind: "error", code: "IDEMPOTENCY_CONFLICT" });
  });
  it("401 → auth (zachowaj do dokończenia po zalogowaniu)", async () => {
    respond(401, { error: { code: "UNAUTHENTICATED" } });
    expect((await submitReceipt(body)).kind).toBe("auth");
  });
  it("400 → error z komunikatem serwera", async () => {
    respond(400, { error: { code: "NOT_INTEGER", message: "Całe sztuki" } });
    expect(await submitReceipt(body)).toMatchObject({ kind: "error", message: "Całe sztuki" });
  });
});
