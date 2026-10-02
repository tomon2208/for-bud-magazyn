import { describe, expect, it } from "vitest";
import {
  ISSUABLE_STATUSES,
  ORDER_STATUS_LABELS,
  createOrderSchema,
  listOrdersQuerySchema,
  orderLabel,
  orderSubLabel,
  updateOrderSchema,
} from "@/lib/validation/orders";
import { mapOrderDbError } from "@/server/orders";
import { mapRequirementError } from "@/server/requirements";

// Etap 8: numer zlecenia, status W produkcji, filtr ISSUABLE, mapowanie błędów (bez bazy).

describe("numer zlecenia i status IN_PRODUCTION (zod)", () => {
  it("create: numer przycięty, pusty → null, > 50 znaków → błąd", () => {
    expect(createOrderSchema.parse({ name: "Kowalski", number: "  Z-12/2026 " })).toEqual({ name: "Kowalski", number: "Z-12/2026" });
    expect(createOrderSchema.parse({ name: "Kowalski", number: "   " }).number).toBeNull();
    expect(createOrderSchema.safeParse({ name: "a", number: "x".repeat(51) }).success).toBe(false);
    expect(createOrderSchema.safeParse({ name: "a", number: "x".repeat(50) }).success).toBe(true);
  });

  it("update: status IN_PRODUCTION i numer; zły status odrzucony", () => {
    expect(updateOrderSchema.parse({ status: "IN_PRODUCTION" })).toEqual({ status: "IN_PRODUCTION" });
    expect(updateOrderSchema.parse({ number: "" })).toEqual({ number: null });
    expect(updateOrderSchema.safeParse({ status: "IN_PROGRESS" }).success).toBe(false);
  });

  it("lista: filtr ISSUABLE i statusy; etykiety i statusy do wydania", () => {
    expect(listOrdersQuerySchema.parse({ status: "ISSUABLE" }).status).toBe("ISSUABLE");
    expect(listOrdersQuerySchema.parse({ status: "IN_PRODUCTION" }).status).toBe("IN_PRODUCTION");
    expect(listOrdersQuerySchema.safeParse({ status: "ALL" }).success).toBe(false);
    expect(ORDER_STATUS_LABELS.IN_PRODUCTION).toBe("W produkcji");
    expect(ISSUABLE_STATUSES).toEqual(["OPEN", "IN_PRODUCTION"]);
  });

  it("numer widoczny obok nazwy: orderLabel i orderSubLabel", () => {
    expect(orderLabel({ name: "Kowalski", number: "Z-1" })).toBe("Z-1 · Kowalski");
    expect(orderLabel({ name: "Kowalski", number: null })).toBe("Kowalski");
    expect(orderSubLabel({ createdAt: "2026-10-02T12:05:00Z", notes: "okna", number: "Z-1" })).toBe(
      "nr Z-1 · utw. 02.10.2026, 14:05 · okna",
    );
    expect(orderSubLabel({ createdAt: "2026-10-02T12:05:00Z", notes: null, number: null })).toBe("utw. 02.10.2026, 14:05");
  });
});

describe("mapowanie błędów bazy", () => {
  it("zlecenia: 23505 → 409 NUMBER_TAKEN; 42501 → 403; 23514 → 400", () => {
    expect(mapOrderDbError({ code: "23505" }, "t")).toMatchObject({ status: 409, code: "NUMBER_TAKEN" });
    expect(mapOrderDbError({ code: "42501" }, "t")).toMatchObject({ status: 403 });
    expect(mapOrderDbError({ code: "23514" }, "t")).toMatchObject({ status: 400 });
  });

  it("zapotrzebowanie: hinty funkcji → statusy API (z kodem materiału w komunikacie)", () => {
    const hint = (h: string, details?: string) => mapRequirementError({ code: "P0001", hint: h, details }, "t");
    expect(hint("ORDER_NOT_OPEN")).toMatchObject({ status: 409, code: "ORDER_NOT_OPEN" });
    expect(hint("ALREADY_WITHDRAWN")).toMatchObject({ status: 409 });
    expect(hint("DUPLICATE_MATERIAL")).toMatchObject({ status: 400 });
    expect(hint("NOT_INTEGER", "K518").message).toContain("K518");
    expect(hint("MATERIAL_INACTIVE", "K519")).toMatchObject({ status: 400, material: "K519" });
    expect(hint("NOT_FOUND", "order")).toMatchObject({ status: 404, message: "Nie znaleziono zlecenia" });
    expect(hint("TOO_MANY_ROWS")).toMatchObject({ status: 400 });
    expect(mapRequirementError({ code: "42501" }, "t")).toMatchObject({ status: 403 });
    expect(mapRequirementError({ code: "22P02" }, "t")).toMatchObject({ status: 400 });
    expect(mapRequirementError({ code: "XX000" }, "t")).toMatchObject({ status: 500 });
  });
});
