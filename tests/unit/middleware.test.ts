import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const session: { sub: string | null } = { sub: null };

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getClaims: async () =>
        session.sub ? { data: { claims: { sub: session.sub } }, error: null } : { data: null, error: null },
    },
  }),
}));

const { middleware, config } = await import("@/middleware");

const BASE = "http://localhost:8787";

function request(path: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  return new NextRequest(new URL(path, BASE), { method: init.method ?? "GET", headers: init.headers });
}

function isPassThrough(res: Response) {
  return res.headers.get("x-middleware-next") === "1";
}

beforeEach(() => {
  session.sub = null;
});

describe("matcher middleware", () => {
  // Next traktuje wzorzec jako wyrażenie path-to-regexp; nasza grupa jest zwykłym regexem.
  const pattern = new RegExp(`^${config.matcher[0]}$`);

  it.each(["/", "/login", "/dashboard", "/m", "/api/v1/admin/users", "/admin/uzytkownicy", "/foo-png", "/apng"])(
    "obejmuje %s",
    (p) => {
      expect(pattern.test(p)).toBe(true);
    },
  );

  it.each([
    "/_next/static/chunks/app.js",
    "/_next/image",
    "/favicon.ico",
    "/logo.png",
    "/a/b/obraz.webp",
    "/robots.txt",
    "/site.webmanifest",
  ])("pomija %s", (p) => {
    expect(pattern.test(p)).toBe(false);
  });

  it("kropka przed rozszerzeniem jest dosłowna (\\.)", () => {
    expect(config.matcher[0]).toContain("\\.(?:svg");
    expect(config.matcher[0]).toContain("favicon\\.ico");
  });
});

describe("middleware — sesja", () => {
  it("strona bez sesji → redirect /login", async () => {
    const res = await middleware(request("/dashboard?x=1"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${BASE}/login`);
  });

  it("/login bez sesji → przepuszcza", async () => {
    expect(isPassThrough(await middleware(request("/login")))).toBe(true);
  });

  it("/api bez sesji → 401 JSON (bez redirectu)", async () => {
    const res = await middleware(request("/api/v1/admin/users"));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
  });

  it("odpowiedzi tworzone w middleware mają nagłówki bezpieczeństwa (przepuszczane — nie, dodaje je next.config)", async () => {
    const passThrough = await middleware(request("/login"));
    expect(passThrough.headers.get("x-frame-options")).toBeNull();
    for (const res of [
      await middleware(request("/api/v1/admin/users")),
      await middleware(request("/dashboard")),
      await middleware(
        request("/api/v1/admin/users", { method: "POST", headers: { "content-type": "text/plain", origin: BASE } }),
      ),
    ]) {
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    }
  });

  it("z sesją → przepuszcza stronę i API", async () => {
    session.sub = "u1";
    expect(isPassThrough(await middleware(request("/dashboard")))).toBe(true);
    expect(isPassThrough(await middleware(request("/api/v1/admin/users")))).toBe(true);
  });
});

describe("middleware — CSRF dla /api", () => {
  beforeEach(() => {
    session.sub = "u1";
  });

  it("POST z text/plain → 415", async () => {
    const res = await middleware(
      request("/api/v1/admin/users", { method: "POST", headers: { "content-type": "text/plain", origin: BASE } }),
    );
    expect(res.status).toBe(415);
  });

  it("POST z obcym Origin → 403", async () => {
    const res = await middleware(
      request("/api/v1/admin/users", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("POST bez Origin i bez Sec-Fetch-Site → 403", async () => {
    const res = await middleware(
      request("/api/v1/admin/users", { method: "POST", headers: { "content-type": "application/json" } }),
    );
    expect(res.status).toBe(403);
  });

  it("POST JSON z tym samym Origin → przepuszcza", async () => {
    const res = await middleware(
      request("/api/v1/admin/users", { method: "POST", headers: { "content-type": "application/json", origin: BASE } }),
    );
    expect(isPassThrough(res)).toBe(true);
  });
});

describe("middleware — zepsute kodowanie w ścieżce skanera (Next zwróciłby 500)", () => {
  beforeEach(() => {
    session.sub = "u1";
  });

  it("API by-code → 404 UNKNOWN_CODE", async () => {
    const res = await middleware(request("/api/v1/locations/by-code/%E0%A4%A"));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "UNKNOWN_CODE", message: "Nieznany kod lokalizacji" } });
  });

  it("strona /m/lokalizacje/[code] → rewrite na ekran nieznanego kodu", async () => {
    const res = await middleware(request("/m/lokalizacje/%E0%A4%A"));
    expect(res.headers.get("x-middleware-rewrite")).toContain("/m/lokalizacje/-");
  });

  it("poprawne kodowanie i inne ścieżki → bez zmian", async () => {
    expect(isPassThrough(await middleware(request("/api/v1/locations/by-code/A%2DB")))).toBe(true);
    expect(isPassThrough(await middleware(request("/m/lokalizacje/A-1")))).toBe(true);
  });
});
