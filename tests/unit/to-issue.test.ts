import { describe, expect, it } from "vitest";
import { suggestIssueQuantity, type ToIssueView } from "@/lib/to-issue";

// Podpowiedź ilości na terminalu: tylko ze świeżych danych, min(pozostało, dostępne w lokalizacji).
const view = (kind: ToIssueView["kind"], items: ToIssueView["items"] = [{ materialId: "m1", remaining: 12 }]): ToIssueView => ({ kind, items });

describe("suggestIssueQuantity", () => {
  it("min(pozostało, dostępne w lokalizacji)", () => {
    expect(suggestIssueQuantity(view("ok"), "m1", 10)).toBe(10);
    expect(suggestIssueQuantity(view("ok"), "m1", 50)).toBe(12);
    expect(suggestIssueQuantity(view("ok", [{ materialId: "m1", remaining: 2.5 }]), "m1", 6.5)).toBe(2.5);
  });

  it("brak podpowiedzi: dane nieświeże (wczytywanie / błąd / brak), materiał spoza listy, pozostało 0, brak stanu", () => {
    for (const kind of ["loading", "error", "none"] as const) expect(suggestIssueQuantity(view(kind), "m1", 10)).toBeNull();
    expect(suggestIssueQuantity(view("ok"), "inny", 10)).toBeNull();
    expect(suggestIssueQuantity(view("ok", [{ materialId: "m1", remaining: 0 }]), "m1", 10)).toBeNull();
    expect(suggestIssueQuantity(view("ok"), "m1", 0)).toBeNull();
  });
});
