import { describe, expect, it } from "vitest";
import {
  createUserSchema,
  fullNameSchema,
  loginFormSchema,
  loginSchema,
  loginToEmail,
  passwordSchema,
  roleSchema,
  updateUserSchema,
  userIdSchema,
} from "@/lib/validation/auth";

describe("loginSchema", () => {
  it.each(["jan", "jan.kowalski", "magazyn-1", "a_b", "x".repeat(32)])("akceptuje %s", (v) => {
    expect(loginSchema.parse(v)).toBe(v);
  });

  it("zamienia na małe litery i przycina spacje", () => {
    expect(loginSchema.parse("  Jan.Kowalski ")).toBe("jan.kowalski");
  });

  it.each(["ab", "x".repeat(33), "jan kowalski", "łukasz", "jan@firma", "", "jan/x"])(
    "odrzuca %j",
    (v) => {
      expect(loginSchema.safeParse(v).success).toBe(false);
    },
  );

  it("odrzuca wartości niebędące tekstem", () => {
    expect(loginSchema.safeParse(123).success).toBe(false);
    expect(loginSchema.safeParse(null).success).toBe(false);
  });
});

describe("passwordSchema", () => {
  it("wymaga min. 8 znaków", () => {
    expect(passwordSchema.safeParse("1234567").success).toBe(false);
    expect(passwordSchema.safeParse("12345678").success).toBe(true);
  });

  it("odrzuca hasło dłuższe niż 72 bajty (limit bcrypt)", () => {
    expect(passwordSchema.safeParse("a".repeat(72)).success).toBe(true);
    expect(passwordSchema.safeParse("a".repeat(73)).success).toBe(false);
    // 37 znaków "ą" = 74 bajty UTF-8
    expect(passwordSchema.safeParse("ą".repeat(37)).success).toBe(false);
  });
});

describe("roleSchema", () => {
  it.each(["ADMIN", "BIURO", "PRODUKCJA"])("akceptuje %s", (r) => {
    expect(roleSchema.parse(r)).toBe(r);
  });
  it.each(["admin", "SZEF", "", undefined])("odrzuca %j", (r) => {
    expect(roleSchema.safeParse(r).success).toBe(false);
  });
});

describe("fullNameSchema", () => {
  it("przycina i wymaga niepustej wartości", () => {
    expect(fullNameSchema.parse("  Jan Kowalski ")).toBe("Jan Kowalski");
    expect(fullNameSchema.safeParse("   ").success).toBe(false);
    expect(fullNameSchema.safeParse("x".repeat(121)).success).toBe(false);
  });
});

describe("createUserSchema", () => {
  const valid = { login: "Jan", full_name: "Jan Kowalski", role: "BIURO", password: "bardzo-tajne" };

  it("normalizuje login", () => {
    expect(createUserSchema.parse(valid).login).toBe("jan");
  });

  it("wymaga wszystkich pól", () => {
    for (const key of Object.keys(valid)) {
      const copy: Record<string, unknown> = { ...valid };
      delete copy[key];
      expect(createUserSchema.safeParse(copy).success, key).toBe(false);
    }
  });
});

describe("updateUserSchema", () => {
  it("akceptuje częściowe zmiany", () => {
    expect(updateUserSchema.parse({ active: false })).toEqual({ active: false });
    expect(updateUserSchema.parse({ role: "ADMIN" })).toEqual({ role: "ADMIN" });
  });

  it("odrzuca pusty obiekt", () => {
    expect(updateUserSchema.safeParse({}).success).toBe(false);
  });

  it("odrzuca nieznane pola (np. próbę zmiany loginu)", () => {
    expect(updateUserSchema.safeParse({ login: "inny" }).success).toBe(false);
    expect(updateUserSchema.safeParse({ active: true, id: "x" }).success).toBe(false);
  });

  it("odrzuca active jako tekst i krótkie hasło", () => {
    expect(updateUserSchema.safeParse({ active: "false" }).success).toBe(false);
    expect(updateUserSchema.safeParse({ password: "krotkie" }).success).toBe(false);
  });
});

describe("loginFormSchema", () => {
  it("normalizuje login i nie sprawdza siły hasła", () => {
    expect(loginFormSchema.parse({ login: " ADMIN ", password: "x" })).toEqual({
      login: "admin",
      password: "x",
    });
    expect(loginFormSchema.safeParse({ login: "", password: "x" }).success).toBe(false);
  });
});

describe("userIdSchema", () => {
  it("akceptuje UUID i odrzuca inne wartości", () => {
    expect(userIdSchema.safeParse("6f1c1e0a-2b0d-4c3e-9f5a-1b2c3d4e5f60").success).toBe(true);
    expect(userIdSchema.safeParse("1 or 1=1").success).toBe(false);
  });
});

describe("loginToEmail", () => {
  it("mapuje login na techniczny e-mail", () => {
    expect(loginToEmail("jan.kowalski")).toBe("jan.kowalski@forbud.local");
    expect(loginToEmail(" Jan ")).toBe("jan@forbud.local");
  });
});
