import { describe, expect, it } from "vitest";
import { checkMutationRequest } from "@/lib/csrf";

const URL_ = "https://magazyn.forbud.pl/api/v1/admin/users";

function req(method: string, headers: Record<string, string>, url = URL_) {
  return { method, url, headers: new Headers(headers) };
}

describe("checkMutationRequest", () => {
  it("metody niemutujące przechodzą bez sprawdzeń", () => {
    expect(checkMutationRequest(req("GET", {}))).toBeNull();
    expect(checkMutationRequest(req("HEAD", { origin: "https://evil.example" }))).toBeNull();
  });

  it.each(["POST", "PUT", "PATCH"])("%s bez application/json → 415", (method) => {
    const r = checkMutationRequest(req(method, { "content-type": "text/plain", origin: "https://magazyn.forbud.pl" }));
    expect(r?.status).toBe(415);
    expect(checkMutationRequest(req(method, { origin: "https://magazyn.forbud.pl" }))?.status).toBe(415);
    expect(
      checkMutationRequest(
        req(method, { "content-type": "application/x-www-form-urlencoded", origin: "https://magazyn.forbud.pl" }),
      )?.status,
    ).toBe(415);
  });

  it("application/json z charset i tym samym Origin → OK", () => {
    expect(
      checkMutationRequest(
        req("POST", { "content-type": "application/json; charset=utf-8", origin: "https://magazyn.forbud.pl" }),
      ),
    ).toBeNull();
  });

  it("obcy Origin → 403 (nawet gdy Sec-Fetch-Site twierdzi inaczej)", () => {
    const r = checkMutationRequest(
      req("POST", {
        "content-type": "application/json",
        origin: "https://evil.example",
        "sec-fetch-site": "same-origin",
      }),
    );
    expect(r).toMatchObject({ status: 403, code: "CSRF" });
  });

  it("Origin z innym portem lub schematem-hostem → 403", () => {
    expect(
      checkMutationRequest(req("POST", { "content-type": "application/json", origin: "https://magazyn.forbud.pl:8443" }))
        ?.status,
    ).toBe(403);
    expect(
      checkMutationRequest(req("POST", { "content-type": "application/json", origin: "https://forbud.pl" }))?.status,
    ).toBe(403);
  });

  it("Origin 'null' lub niepoprawny → 403", () => {
    expect(checkMutationRequest(req("POST", { "content-type": "application/json", origin: "null" }))?.status).toBe(403);
  });

  it("brak Origin: Sec-Fetch-Site same-origin → OK, inne/brak → 403", () => {
    expect(
      checkMutationRequest(req("PATCH", { "content-type": "application/json", "sec-fetch-site": "same-origin" })),
    ).toBeNull();
    expect(
      checkMutationRequest(req("PATCH", { "content-type": "application/json", "sec-fetch-site": "cross-site" }))?.status,
    ).toBe(403);
    expect(checkMutationRequest(req("PATCH", { "content-type": "application/json" }))?.status).toBe(403);
  });

  it("Origin zgodny z nagłówkiem Host (np. za proxy) → OK", () => {
    expect(
      checkMutationRequest(
        req(
          "POST",
          { "content-type": "application/json", origin: "http://localhost:8787", host: "localhost:8787" },
          "http://127.0.0.1:8787/api/x",
        ),
      ),
    ).toBeNull();
  });

  it("DELETE bez treści nie wymaga Content-Type, ale wymaga tego samego Origin", () => {
    expect(checkMutationRequest(req("DELETE", { origin: "https://magazyn.forbud.pl" }))).toBeNull();
    expect(checkMutationRequest(req("DELETE", { origin: "https://evil.example" }))?.status).toBe(403);
    expect(
      checkMutationRequest(req("DELETE", { origin: "https://magazyn.forbud.pl", "content-length": "10" }))?.status,
    ).toBe(415);
  });
});
