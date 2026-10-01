import { describe, expect, it, vi } from "vitest";
import { isLastAdminError, mapAuthError } from "@/server/users";

describe("mapAuthError", () => {
  it("zajęty login → 409", () => {
    expect(mapAuthError({ code: "email_exists", status: 422 }, "t")).toMatchObject({
      status: 409,
      code: "LOGIN_TAKEN",
    });
  });

  it("słabe hasło → 400", () => {
    expect(mapAuthError({ code: "weak_password" }, "t")).toMatchObject({ status: 400, code: "WEAK_PASSWORD" });
  });

  it("nieznany błąd → 500 bez szczegółów", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const e = mapAuthError({ code: "unexpected_failure", status: 500 }, "t");
    expect(e).toMatchObject({ status: 500, code: "INTERNAL" });
    expect(e.message).not.toContain("unexpected_failure");
    spy.mockRestore();
  });
});

describe("isLastAdminError", () => {
  it("rozpoznaje błąd z triggera ochrony ostatniego admina", () => {
    expect(isLastAdminError({ code: "P0001", hint: "LAST_ADMIN" })).toBe(true);
    expect(isLastAdminError({ code: "P0001", hint: null })).toBe(false);
    expect(isLastAdminError({ code: "23505", hint: "LAST_ADMIN" })).toBe(false);
  });
});
