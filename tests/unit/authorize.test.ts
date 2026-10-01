import { describe, expect, it } from "vitest";
import { authorize, homePathForRole } from "@/lib/authorize";

describe("authorize", () => {
  it("brak użytkownika → unauthenticated", () => {
    expect(authorize(null, ["ADMIN"])).toBe("unauthenticated");
    expect(authorize(null, [])).toBe("unauthenticated");
  });

  it("rola spoza listy → forbidden", () => {
    expect(authorize({ role: "BIURO" }, ["ADMIN"])).toBe("forbidden");
    expect(authorize({ role: "PRODUKCJA" }, ["ADMIN", "BIURO"])).toBe("forbidden");
  });

  it("rola z listy lub pusta lista → ok", () => {
    expect(authorize({ role: "ADMIN" }, ["ADMIN"])).toBe("ok");
    expect(authorize({ role: "PRODUKCJA" }, ["PRODUKCJA", "ADMIN"])).toBe("ok");
    expect(authorize({ role: "BIURO" }, [])).toBe("ok");
  });
});

describe("homePathForRole", () => {
  it("PRODUKCJA → terminal mobilny, pozostali → dashboard", () => {
    expect(homePathForRole("PRODUKCJA")).toBe("/m");
    expect(homePathForRole("BIURO")).toBe("/dashboard");
    expect(homePathForRole("ADMIN")).toBe("/dashboard");
  });
});
