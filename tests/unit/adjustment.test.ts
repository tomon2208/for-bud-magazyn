import { describe, expect, it } from "vitest";
import { formatDelta, previewAdjustment, quantityDelta } from "@/lib/adjustment";
import { CONFIRM_ARM_MS, confirmClickAllowed } from "@/lib/confirm-guard";
import {
  ADJUSTMENT_REASONS,
  adjustmentSchema,
  checkQuantity,
  historyQuerySchema,
  reasonLabel,
  reversalSchema,
} from "@/lib/validation/stock";
import { mapStockError } from "@/server/stock";

// Etap 6 — czysta logika: walidacja korekty i storna, podgląd różnicy, mapowanie błędów DB.

const CRID = "0b8f8a3e-4a4c-4c86-9a43-0f0f7e1d2c3b";
const ID = "6f1c1e0a-2b0d-4c3e-9f5a-1b2c3d4e5f60";
const base = { client_request_id: CRID, material_id: ID, location_id: ID, target_quantity: 3, expected_current: 5, reason_code: "ZAGINIECIE" };

describe("checkQuantity({ allowZero })", () => {
  it.each([
    ["0", 0],
    ["0,000", 0],
    [0, 0],
    ["2,5", 2.5],
  ])("%s → %s", (raw, value) => {
    expect(checkQuantity(raw, true, { allowZero: true })).toEqual({ ok: true, value });
  });

  it("bez allowZero 0 nadal odrzucane; ujemne zawsze", () => {
    expect(checkQuantity("0").ok).toBe(false);
    expect(checkQuantity("-1", true, { allowZero: true })).toEqual({ ok: false, message: "Ilość nie może być ujemna" });
  });
});

describe("adjustmentSchema", () => {
  it("target ≥ 0 (także 0), expected ≥ 0; tekst z przecinkiem", () => {
    expect(adjustmentSchema.safeParse({ ...base, target_quantity: 0 }).success).toBe(true);
    const r = adjustmentSchema.safeParse({ ...base, target_quantity: "1,5", expected_current: "0" });
    expect(r.success && [r.data.target_quantity, r.data.expected_current]).toEqual([1.5, 0]);
  });

  it.each(ADJUSTMENT_REASONS.filter((r) => r !== "INNY"))("powód %s bez opisu — OK", (code) => {
    expect(adjustmentSchema.safeParse({ ...base, reason_code: code }).success).toBe(true);
  });

  it("INNY wymaga opisu; z opisem OK", () => {
    const bad = adjustmentSchema.safeParse({ ...base, reason_code: "INNY", reason: "  " });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]).toMatchObject({ path: ["reason"], message: "Opisz powód korekty" });
    expect(adjustmentSchema.safeParse({ ...base, reason_code: "INNY", reason: "inwentura" }).success).toBe(true);
  });

  it("powody wydań (SERWIS, PROBKA) nie są powodami korekty; nieznane pola odrzucone", () => {
    expect(adjustmentSchema.safeParse({ ...base, reason_code: "SERWIS" }).success).toBe(false);
    expect(adjustmentSchema.safeParse({ ...base, reason_code: "PROBKA" }).success).toBe(false);
    expect(adjustmentSchema.safeParse({ ...base, user_id: ID }).success).toBe(false);
  });

  it("target ujemny / > 1 000 000 / 4 miejsca → błąd", () => {
    for (const t of [-1, 1_000_001, "0,0001"]) expect(adjustmentSchema.safeParse({ ...base, target_quantity: t }).success).toBe(false);
  });
});

describe("reversalSchema", () => {
  const r = { client_request_id: CRID, operation_id: ID, reason: "pomyłka" };
  it("powód ≥ 3 znaki po przycięciu", () => {
    expect(reversalSchema.safeParse(r).success).toBe(true);
    expect(reversalSchema.safeParse({ ...r, reason: "  ab  " }).success).toBe(false);
    expect(reversalSchema.safeParse({ ...r, reason: undefined }).success).toBe(false);
    expect(reversalSchema.safeParse({ ...r, reason: "abc" }).success).toBe(true);
  });
});

describe("historyQuerySchema", () => {
  it("typ REVERSAL i ADJUSTMENT dozwolone; od > do → błąd", () => {
    expect(historyQuerySchema.safeParse({ type: "REVERSAL" }).success).toBe(true);
    expect(historyQuerySchema.safeParse({ type: "ADJUSTMENT" }).success).toBe(true);
    expect(historyQuerySchema.safeParse({ from: "2026-10-02", to: "2026-10-01" }).success).toBe(false);
  });
});

describe("previewAdjustment — różnica na żywo", () => {
  it.each([
    ["3", 5, { kind: "diff", target: 3, delta: -2, label: "−2 szt." }],
    ["8", 5, { kind: "diff", target: 8, delta: 3, label: "+3 szt." }],
    ["0", 5, { kind: "diff", target: 0, delta: -5, label: "−5 szt." }],
    ["5", 5, { kind: "same", target: 5 }],
    ["", 5, { kind: "empty" }],
  ] as const)("%s przy stanie %s", (raw, current, expected) => {
    expect(previewAdjustment(raw, current, "szt.", false)).toEqual(expected);
  });

  it("ułamki: mb 0,3 przy 0,1 → +0,2 (bez błędu zmiennoprzecinkowego)", () => {
    expect(previewAdjustment("0,3", 0.1, "mb", true)).toEqual({ kind: "diff", target: 0.3, delta: 0.2, label: "+0,2 mb" });
    expect(quantityDelta(0.3, 0.1)).toBe(0.2);
  });

  it("szt. z ułamkiem / ujemne → invalid", () => {
    expect(previewAdjustment("1,5", 2, "szt.", false).kind).toBe("invalid");
    expect(previewAdjustment("-1", 2, "szt.", false).kind).toBe("invalid");
  });

  it("formatDelta", () => {
    expect(formatDelta(-2.5, "mb")).toBe("−2,5 mb");
    expect(formatDelta(1000, "szt.")).toBe("+1000 szt.".replace("1000", (1000).toLocaleString("pl-PL")));
  });
});

describe("reasonLabel — per typ operacji", () => {
  it("korekta i wydanie mają własne etykiety (wspólny kod USZKODZENIE)", () => {
    expect(reasonLabel("ADJUSTMENT", "ZAGINIECIE")).toBe("Zaginięcie / kradzież");
    expect(reasonLabel("ADJUSTMENT", "USZKODZENIE")).toBe("Uszkodzenie / zniszczenie");
    expect(reasonLabel("ISSUE", "USZKODZENIE")).toBe("Uszkodzenie");
    expect(reasonLabel("ISSUE", null)).toBe("");
  });
});

describe("mapStockError — Etap 6", () => {
  it("STOCK_CHANGED → 409 z aktualnym stanem", () => {
    expect(mapStockError({ code: "P0001", hint: "STOCK_CHANGED", details: "4.000" }, "t")).toMatchObject({
      status: 409,
      code: "STOCK_CHANGED",
      details: { current: 4 },
    });
  });

  it("INSUFFICIENT_STOCK storna: JSON z lokalizacją", () => {
    const e = mapStockError({ code: "P0001", hint: "INSUFFICIENT_STOCK", details: '{"available": 2.000, "location_code": "A-01"}' }, "t");
    expect(e).toMatchObject({ status: 409, code: "INSUFFICIENT_STOCK", details: { available: 2, locationCode: "A-01" } });
    expect(e.message).toContain("A-01");
  });

  it("INSUFFICIENT_STOCK zwykły nadal z dostępną ilością", () => {
    expect(mapStockError({ code: "P0001", hint: "INSUFFICIENT_STOCK", details: "7" }, "t").details).toEqual({ available: 7 });
  });

  it.each([
    ["NO_CHANGE", 409],
    ["ALREADY_REVERSED", 409],
    ["NOT_REVERSIBLE", 409],
  ])("%s → %s", (hint, status) => {
    expect(mapStockError({ code: "P0001", hint }, "t")).toMatchObject({ status, code: hint });
  });

  it("NOT_FOUND operacji; LOCATION_INACTIVE z kodem; 23505 reverses_operation_id → ALREADY_REVERSED", () => {
    expect(mapStockError({ code: "P0001", hint: "NOT_FOUND", details: "operation" }, "t")).toMatchObject({
      status: 404,
      message: "Nie znaleziono operacji",
    });
    expect(mapStockError({ code: "P0001", hint: "LOCATION_INACTIVE", details: "B-02" }, "t").message).toContain("B-02");
    expect(
      mapStockError({ code: "23505", message: 'duplicate key value violates unique constraint "stock_operations_reverses_operation_id_key"' }, "t"),
    ).toMatchObject({ status: 409, code: "ALREADY_REVERSED" });
    expect(mapStockError({ code: "23505", message: "client_request_id" }, "t")).toMatchObject({ code: "RETRY" });
  });
});

describe("confirmClickAllowed — ochrona potwierdzenia przed dwuklikiem (review M1)", () => {
  it("drugie kliknięcie dwukliku (detail 2) zawsze ignorowane", () => {
    expect(confirmClickAllowed(0, 10_000, 2)).toBe(false);
  });
  it("kliknięcie < 400 ms po wejściu w potwierdzenie ignorowane, później dozwolone; klawiatura (detail 0) jak klik", () => {
    expect(confirmClickAllowed(1_000, 1_399, 1)).toBe(false);
    expect(confirmClickAllowed(1_000, 1_400, 1)).toBe(true);
    expect(confirmClickAllowed(1_000, 1_500, 0)).toBe(true);
    expect(CONFIRM_ARM_MS).toBe(400);
  });
});
