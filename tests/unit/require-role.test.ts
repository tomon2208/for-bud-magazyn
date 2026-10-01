import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock klienta Supabase: claims z JWT + odczyt profilu.
const state: {
  sub: string | null;
  profile: Record<string, unknown> | null;
  profileError: { code: string } | null;
} = { sub: null, profile: null, profileError: null };

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: {
      getClaims: async () =>
        state.sub ? { data: { claims: { sub: state.sub } }, error: null } : { data: null, error: null },
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: state.profile, error: state.profileError }),
        }),
      }),
    }),
  }),
}));

class RedirectError extends Error {
  constructor(public url: string) {
    super(`redirect:${url}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectError(url);
  },
}));

const { requireApiRole, requirePageRole, getCurrentUser } = await import("@/server/auth");

function profile(role: string, active = true) {
  return { id: "u1", login: "jan", full_name: "Jan", role, active };
}

beforeEach(() => {
  state.sub = null;
  state.profile = null;
  state.profileError = null;
});

describe("getCurrentUser", () => {
  it("bez sesji → null", async () => {
    expect(await getCurrentUser()).toBeNull();
  });

  it("nieaktywny profil → null", async () => {
    state.sub = "u1";
    state.profile = profile("ADMIN", false);
    expect(await getCurrentUser()).toBeNull();
  });

  it("sesja bez profilu → null", async () => {
    state.sub = "u1";
    expect(await getCurrentUser()).toBeNull();
  });

  it("błąd odczytu profilu → null", async () => {
    state.sub = "u1";
    state.profileError = { code: "500" };
    expect(await getCurrentUser()).toBeNull();
  });

  it("aktywny profil → dane z profiles", async () => {
    state.sub = "u1";
    state.profile = profile("BIURO");
    expect(await getCurrentUser()).toEqual({ id: "u1", login: "jan", fullName: "Jan", role: "BIURO" });
  });
});

describe("requireApiRole", () => {
  it("bez sesji → 401 JSON", async () => {
    const r = await requireApiRole("ADMIN");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(401);
      expect(await r.response.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    }
  });

  it("konto nieaktywne → 401", async () => {
    state.sub = "u1";
    state.profile = profile("ADMIN", false);
    const r = await requireApiRole("ADMIN");
    expect(!r.ok && r.response.status).toBe(401);
  });

  it("zła rola → 403 JSON", async () => {
    state.sub = "u1";
    state.profile = profile("PRODUKCJA");
    const r = await requireApiRole("ADMIN");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(403);
      expect(await r.response.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    }
  });

  it("właściwa rola → użytkownik", async () => {
    state.sub = "u1";
    state.profile = profile("ADMIN");
    const r = await requireApiRole("ADMIN");
    expect(r.ok && r.user.role).toBe("ADMIN");
  });
});

describe("requirePageRole", () => {
  it("bez sesji → redirect /login", async () => {
    await expect(requirePageRole("ADMIN")).rejects.toMatchObject({ url: "/login" });
  });

  it("konto nieaktywne → redirect /login z komunikatem", async () => {
    state.sub = "u1";
    state.profile = profile("BIURO", false);
    await expect(requirePageRole("BIURO")).rejects.toMatchObject({ url: "/login?konto=nieaktywne" });
  });

  it("PRODUKCJA na stronie biurowej → redirect /m", async () => {
    state.sub = "u1";
    state.profile = profile("PRODUKCJA");
    await expect(requirePageRole("ADMIN", "BIURO")).rejects.toMatchObject({ url: "/m" });
  });

  it("BIURO na stronie ADMIN → redirect /dashboard", async () => {
    state.sub = "u1";
    state.profile = profile("BIURO");
    await expect(requirePageRole("ADMIN")).rejects.toMatchObject({ url: "/dashboard" });
  });

  it("właściwa rola → użytkownik", async () => {
    state.sub = "u1";
    state.profile = profile("ADMIN");
    await expect(requirePageRole("ADMIN")).resolves.toMatchObject({ role: "ADMIN" });
  });
});
