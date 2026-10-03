import { describe, expect, it } from "vitest";
import { parsePending, type PendingOperation } from "@/lib/pending-operation";
import {
  formatSubstitutesInStock,
  parseSubstitutes,
  substituteLabel,
  substituteSplit,
  substituteCandidates,
  substituteQuantityError,
  defaultSubstituteChoice,
  substitutesInStock,
  suggestSubstituteQuantity,
  type SubstituteOption,
} from "@/lib/substitutes";
import { addSubstituteSchema } from "@/lib/validation/catalog";
import { substituteRequirementSchema } from "@/lib/validation/requirements";
import { issueSchema } from "@/lib/validation/stock";
import { suggestQuantityForRow } from "@/lib/to-issue";
import { availabilityInfo, type PreviewItem } from "@/modules/liczokno-import/resolve";

// Etap 12b (ADR 017): odpowiedniki — czyste funkcje (podpowiedź ilości, podział „Podmień”, dopiski), walidacja zod,
// zgodność zapisu niepotwierdzonego wydania (ctx.substituteFor ↔ payload.substitute_for), informacja przy imporcie.

const A = "6f1c1e0a-2b0d-4c3e-9f5a-1b2c3d4e5f60";
const B = "7a2d2f1b-3c1e-4d4f-8a6b-2c3d4e5f6071";
const C = "8b3e3a2c-4d2f-4e5a-9b7c-3d4e5f607182";
const CRID = "0b8f8a3e-4a4c-4c86-9a43-0f0f7e1d2c3b";

const opt = (code: string, free: number, extra: Partial<SubstituteOption> = {}): SubstituteOption => ({
  materialId: `id-${code}`,
  code,
  name: `n ${code}`,
  unit: "szt.",
  allowsFraction: false,
  free,
  ownReserved: 0,
  available: free,
  ...extra,
});

describe("parseSubstitutes", () => {
  it("mapuje jsonb z SQL; liczby z tekstu; pozycje bez id pomijane; nie-tablica → []", () => {
    expect(
      parseSubstitutes([
        { material_id: "m1", code: "YYY", name: "Y", unit: "szt.", allows_fraction: false, free: "5.000", own_reserved: "2", available: "7" },
        { code: "bez id" },
        null,
      ]),
    ).toEqual([{ materialId: "m1", code: "YYY", name: "Y", unit: "szt.", allowsFraction: false, free: 5, ownReserved: 2, available: 7 }]);
    expect(parseSubstitutes(null)).toEqual([]);
    expect(parseSubstitutes({})).toEqual([]);
    // brak available → wolne; ujemne / NaN → 0
    expect(parseSubstitutes([{ material_id: "m", free: 3 }])[0]).toMatchObject({ free: 3, available: 3, allowsFraction: true });
    expect(parseSubstitutes([{ material_id: "m", free: "-1", available: "x" }])[0]).toMatchObject({ free: 0, available: 0 });
  });
});

describe("dopiski i filtry", () => {
  it("formatSubstitutesInStock — tylko na stanie, przecinek dziesiętny", () => {
    expect(formatSubstitutesInStock([opt("YYY", 5), opt("ZZZ", 0), opt("WWW", 2.5)])).toBe("YYY (wolne 5), WWW (wolne 2,5)");
    expect(formatSubstitutesInStock([opt("ZZZ", 0)])).toBe("");
    expect(formatSubstitutesInStock([opt("YYY", 0, { available: 3 })], "available")).toBe("YYY (dostępne 3)");
    expect(substitutesInStock([opt("A", 0), opt("B", 1)]).map((s) => s.code)).toEqual(["B"]);
  });

  it("substituteLabel", () => {
    expect(substituteLabel("XXX", "Narożnik")).toBe("zamiennik za XXX (Narożnik)");
    expect(substituteLabel("XXX")).toBe("zamiennik za XXX");
    expect(substituteLabel(null)).toBe("");
  });
});

describe("suggestSubstituteQuantity — min(pozostało oryginału, dostępne zamiennika dla zlecenia, w lokalizacji)", () => {
  it.each([
    [4, 10, 7, false, 4],
    [10, 3, 7, false, 3],
    [10, 8, 2, false, 2],
    [2.5, 10, 10, false, 2], // materiał bez ułamków — w dół
    [2.5, 10, 10, true, 2.5],
    [0.4, 10, 10, false, null], // po zaokrągleniu 0
    [0, 10, 10, false, null],
    [5, 0, 10, false, null],
    [5, 10, 0, false, null],
  ])("(%s, %s, %s, ułamki %s) → %s", (rem, avail, loc, frac, expected) => {
    expect(suggestSubstituteQuantity(rem, avail, loc, frac)).toBe(expected);
  });
});

describe("substituteCandidates — podpowiedź „Policz jako zamiennik za” (H1: bez automatu w bazie)", () => {
  const y = (code = "YYY") => opt(code, 1, { materialId: "Y" });
  const items = [
    { materialId: "X", materialCode: "XXX", remaining: 3, substitutes: [y()] },
    { materialId: "W", materialCode: "WWW", remaining: 3, substitutes: [y()] },
    { materialId: "V", materialCode: "VVV", remaining: 5, substitutes: [y()] },
    { materialId: "D", materialCode: "DDD", remaining: 0, substitutes: [y()] },
    { materialId: "Z", materialCode: "ZZZ", remaining: 2, substitutes: [opt("QQQ", 1, { materialId: "Q" })] },
  ];
  it("największe pozostało pierwsze, remis po kodzie; bez pozycji z pozostało 0 i bez nie-odpowiedników", () => {
    expect(substituteCandidates(items, "Y").map((i) => i.materialCode)).toEqual(["VVV", "WWW", "XXX"]);
    expect(substituteCandidates(items, "NONE")).toEqual([]);
  });
  it("materiał z własnym pozostało > 0 → brak podpowiedzi (zwykłe wydanie)", () => {
    expect(substituteCandidates([...items, { materialId: "Y", materialCode: "YYY", remaining: 1, substitutes: [] }], "Y")).toEqual([]);
    // własna pozycja w pełni wydana → podpowiedź wraca
    expect(substituteCandidates([...items, { materialId: "Y", materialCode: "YYY", remaining: 0, substitutes: [] }], "Y")).toHaveLength(3);
  });
});

describe("zamiennik za oryginał bez ułamków (re-review 2)", () => {
  it("substituteQuantityError — komunikat z kodem oryginału tylko dla ułamka przy oryginale bez ułamków", () => {
    expect(substituteQuantityError(1.5, { code: "XXX", allowsFraction: false })).toContain("XXX");
    expect(substituteQuantityError(2, { code: "XXX", allowsFraction: false })).toBeNull();
    expect(substituteQuantityError(1.5, { code: "XXX", allowsFraction: true })).toBeNull();
  });
  it("defaultSubstituteChoice — pierwszy kandydat z dopuszczalną ilością, inaczej zwykłe wydanie", () => {
    const c = [
      { id: "a", code: "A", allowsFraction: false },
      { id: "b", code: "B", allowsFraction: true },
    ];
    expect(defaultSubstituteChoice(c, 2)).toBe("a");
    expect(defaultSubstituteChoice(c, 1.5)).toBe("b");
    expect(defaultSubstituteChoice([c[0]], 1.5)).toBe("");
  });
  it("suggestQuantityForRow — nie podpowiada ułamka, gdy oryginał jest bez ułamków", () => {
    const row = { materialId: "Y", quantity: 7, allowsFraction: true };
    const view = { kind: "ok" as const, items: [] };
    expect(suggestQuantityForRow(view, row, { id: "X", remaining: 2.5, subAvailable: 9, allowsFraction: false })).toBe(2);
    expect(suggestQuantityForRow(view, row, { id: "X", remaining: 2.5, subAvailable: 9, allowsFraction: true })).toBe(2.5);
  });
});

describe("suggestQuantityForRow — dane zamiennika parametrem (L3)", () => {
  const view = { kind: "ok" as const, items: [{ materialId: "Y", remaining: 4, available: 10 }] };
  const row = { materialId: "Y", quantity: 7, allowsFraction: false };
  it("zamiennik → min(pozostało oryginału, dostępne zamiennika, w lokalizacji); bez → jak suggestIssueQuantity", () => {
    expect(suggestQuantityForRow(view, row, { id: "X", remaining: 2.5, subAvailable: 9 })).toBe(2);
    expect(suggestQuantityForRow(view, { ...row, allowsFraction: true }, { id: "X", remaining: 2.5, subAvailable: 9 })).toBe(2.5);
    expect(suggestQuantityForRow(view, row, null)).toBe(4);
    expect(suggestQuantityForRow({ kind: "loading", items: [] }, row, null)).toBeNull();
    // „zamiennik” wskazujący ten sam materiał — traktowany jak zwykłe wydanie
    expect(suggestQuantityForRow(view, row, { id: "Y", remaining: 1, subAvailable: 1 })).toBe(4);
  });
});

describe("substituteSplit — „Podmień” (jak SQL substitute_requirement_item)", () => {
  it.each([
    // [ilość na liście, potrzebne łącznie, wydano, zostaje, przenosi]
    [10, 10, 0, 0, 10],
    [10, 10, 4, 4, 6],
    [10, 10, 12, 10, 0],
    [10, 15, 4, 0, 10], // inne listy (5) pokrywają wydane 4
    [10, 15, 8, 3, 7],
    [2.5, 2.5, 1.25, 1.25, 1.25],
  ])("(%s, %s, %s) → zostaje %s, przenosi %s", (item, needed, issued, keep, move) => {
    expect(substituteSplit(item, needed, issued)).toEqual({ keep, move });
  });
});

describe("walidacja", () => {
  const base = { client_request_id: CRID, location_id: A, material_id: B, quantity: 1 };
  it("issueSchema.substitute_for — tylko przy wydaniu na zlecenie i ≠ materiał", () => {
    expect(issueSchema.safeParse({ ...base, production_order_id: C, substitute_for: A }).success).toBe(true);
    expect(issueSchema.safeParse({ ...base, production_order_id: C, substitute_for: null }).success).toBe(true);
    expect(issueSchema.safeParse({ ...base, production_order_id: C }).success).toBe(true);
    const noOrder = issueSchema.safeParse({ ...base, reason_code: "SERWIS", substitute_for: A });
    expect(noOrder.success ? null : noOrder.error.issues[0].path).toEqual(["substitute_for"]);
    const same = issueSchema.safeParse({ ...base, production_order_id: C, substitute_for: B });
    expect(same.success ? null : same.error.issues[0].message).toBe("Zamiennik musi być innym materiałem niż oryginał");
    expect(issueSchema.safeParse({ ...base, production_order_id: C, substitute_for: "x" }).success).toBe(false);
  });

  it("substituteRequirementSchema — uuid, różne materiały, powód ≤ 200 (pusty → null), strict", () => {
    const ok = substituteRequirementSchema.safeParse({ client_request_id: CRID, from_material_id: A, to_material_id: B, reason: "  " });
    expect(ok.success && ok.data.reason).toBeNull();
    expect(substituteRequirementSchema.safeParse({ client_request_id: CRID, from_material_id: A, to_material_id: B }).success).toBe(true);
    expect(substituteRequirementSchema.safeParse({ client_request_id: CRID, from_material_id: A, to_material_id: A }).success).toBe(false);
    expect(substituteRequirementSchema.safeParse({ client_request_id: CRID, from_material_id: A, to_material_id: B, reason: "x".repeat(201) }).success).toBe(false);
    expect(substituteRequirementSchema.safeParse({ from_material_id: A, to_material_id: B }).success).toBe(false);
    expect(substituteRequirementSchema.safeParse({ client_request_id: CRID, from_material_id: A, to_material_id: B, extra: 1 }).success).toBe(false);
  });

  it("addSubstituteSchema", () => {
    expect(addSubstituteSchema.safeParse({ substitute_id: A }).success).toBe(true);
    expect(addSubstituteSchema.safeParse({ substitute_id: "x" }).success).toBe(false);
    expect(addSubstituteSchema.safeParse({ substitute_id: A, x: 1 }).success).toBe(false);
  });
});

describe("parsePending — wydanie zamiennika", () => {
  const NOW = 1_700_000_000_000;
  const material = { id: "m1", code: "YYY", name: "Y", unit: "szt.", allowsFraction: false, defaultSupplierId: null };
  const p: PendingOperation<"ISSUE"> = {
    v: 2,
    kind: "ISSUE",
    userId: "u1",
    requestId: "r1",
    payload: { client_request_id: "r1", location_id: "l1", material_id: "m1", quantity: 1, production_order_id: "o1", reason_code: null, substitute_for: "x1" },
    ctx: {
      location: { id: "l1", code: "A", name: null },
      material,
      target: { kind: "order", id: "o1", name: "Kowalski" },
      substituteFor: { id: "x1", code: "XXX", name: "X" },
    },
    savedAt: NOW - 1000,
  };
  const raw = (v: unknown) => JSON.stringify(v);
  it("zgodny kontekst → poprawny; rozbieżność ctx ↔ payload → null", () => {
    expect(parsePending(raw(p), "ISSUE", "u1", NOW)).toEqual(p);
    expect(parsePending(raw({ ...p, ctx: { ...p.ctx, substituteFor: { id: "x2", code: "Q", name: "" } } }), "ISSUE", "u1", NOW)).toBeNull();
    expect(parsePending(raw({ ...p, ctx: { ...p.ctx, substituteFor: undefined } }), "ISSUE", "u1", NOW)).toBeNull();
    expect(parsePending(raw({ ...p, payload: { ...p.payload, substitute_for: null } }), "ISSUE", "u1", NOW)).toBeNull();
    expect(parsePending(raw({ ...p, ctx: { ...p.ctx, substituteFor: { id: "x1" } } }), "ISSUE", "u1", NOW)).toBeNull();
    // bez zamiennika — jak dotąd
    const plain = { ...p, payload: { ...p.payload, substitute_for: undefined }, ctx: { ...p.ctx, substituteFor: undefined } };
    expect(parsePending(raw(plain), "ISSUE", "u1", NOW)).not.toBeNull();
  });
});

describe("import — availabilityInfo (informacja, nie blokada)", () => {
  const material = {
    id: "m",
    code: "XXX",
    name: "X",
    unit: "szt.",
    allowsFraction: false,
    barLengthM: null,
    active: true,
    free: 2,
    substitutes: [opt("YYY", 5), opt("ZZZ", 0)],
  };
  const item = (quantity: number | null, ready = true, m: PreviewItem["material"] = material) => ({ ready, quantity, material: m });
  it("ilość > wolne → wolne + odpowiedniki na stanie; inaczej null", () => {
    expect(availabilityInfo(item(6))).toBe("Na stanie wolne: 2 szt. — odpowiednik YYY: 5 szt. (podmiana po zapisie — w Brakach zlecenia)");
    expect(availabilityInfo(item(2))).toBeNull();
    expect(availabilityInfo(item(6, false))).toBeNull();
    expect(availabilityInfo(item(null))).toBeNull();
    expect(availabilityInfo(item(6, true, { ...material, free: undefined }))).toBeNull();
    expect(availabilityInfo(item(6, true, { ...material, substitutes: [] }))).toBe("Na stanie wolne: 2 szt.");
  });
});
