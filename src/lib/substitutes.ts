// Odpowiedniki (zamienniki) materiałów — Etap 12b (ADR 017). Czyste funkcje wspólne dla serwera i UI.

/** Odpowiednik z wolnym stanem (z funkcji SQL app.substitute_availability). */
export type SubstituteOption = {
  materialId: string;
  code: string;
  name: string;
  unit: string;
  allowsFraction: boolean;
  /** Wolne w magazynie (stan aktywnych lokalizacji − wszystkie rezerwacje, min. 0). */
  free: number;
  /** Rezerwacja zlecenia (gdy liczone dla zlecenia) na odpowiednik. */
  ownReserved: number;
  /** Dostępne do wydania na zlecenie = wolne + rezerwacja zlecenia (bez zlecenia = wolne). */
  available: number;
};

function num(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** jsonb `substitutes` z funkcji SQL → lista (pozycje bez id są pomijane). */
export function parseSubstitutes(raw: unknown): SubstituteOption[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null && typeof (s as { material_id?: unknown }).material_id === "string")
    .map((s) => ({
      materialId: s.material_id as string,
      code: typeof s.code === "string" ? s.code : "",
      name: typeof s.name === "string" ? s.name : "",
      unit: typeof s.unit === "string" ? s.unit : "",
      allowsFraction: s.allows_fraction !== false,
      free: num(s.free),
      ownReserved: num(s.own_reserved),
      available: num(s.available ?? s.free),
    }));
}

/** Odpowiedniki, które są na stanie (dostępne > 0). */
export function substitutesInStock(list: SubstituteOption[]): SubstituteOption[] {
  return list.filter((s) => s.available > 0);
}

const plQty = (n: number) => n.toLocaleString("pl-PL", { maximumFractionDigits: 3 });

/** „YYY (wolne 5), ZZZ (wolne 2)” — tylko odpowiedniki na stanie; pusty tekst, gdy żadnego. */
export function formatSubstitutesInStock(list: SubstituteOption[], field: "free" | "available" = "free"): string {
  return list
    .filter((s) => s[field] > 0)
    .map((s) => `${s.code} (${field === "free" ? "wolne" : "dostępne"} ${plQty(s[field])})`)
    .join(", ");
}

/**
 * Podpowiedź ilości przy wydaniu zamiennika YYY za XXX: min(pozostało XXX, dostępne YYY dla zlecenia, stan YYY w
 * lokalizacji). Materiał bez ułamków — w dół do całości. null, gdy nie ma czego podpowiedzieć.
 */
export function suggestSubstituteQuantity(
  remainingOriginal: number,
  availableForOrder: number,
  availableAtLocation: number,
  allowsFraction: boolean,
): number | null {
  if (!(remainingOriginal > 0) || !(availableForOrder > 0) || !(availableAtLocation > 0)) return null;
  let q = Math.min(remainingOriginal, availableForOrder, availableAtLocation);
  if (!allowsFraction) q = Math.floor(q);
  else q = Math.round(q * 1000) / 1000;
  return q > 0 ? q : null;
}

/**
 * Kandydaci „Policz jako zamiennik za XXX” (ADR 017 H1 — baza nie przypisuje zamiennika sama, UI podpowiada): gdy
 * wybrany materiał YYY NIE ma „pozostało” > 0 na zleceniu, pozycje XXX z pozostało > 0, których odpowiednikiem jest
 * YYY. Kolejność: największe pozostało, remis po kodzie — pierwszy kandydat jest domyślnym wyborem. YYY z własnym
 * „pozostało” → [] (zwykłe wydanie).
 */
export function substituteCandidates<T extends { materialId: string; materialCode: string; remaining: number; substitutes: SubstituteOption[] }>(
  toIssue: T[],
  materialId: string,
): T[] {
  if (toIssue.some((i) => i.materialId === materialId && i.remaining > 0)) return [];
  return toIssue
    .filter((i) => i.materialId !== materialId && i.remaining > 0 && i.substitutes.some((s) => s.materialId === materialId))
    .sort((x, y) => y.remaining - x.remaining || x.materialCode.localeCompare(y.materialCode, "pl"));
}

/** Tekst „zamiennik za XXX” (z kodem i nazwą, gdy znane). */
export function substituteLabel(code: string | null | undefined, name?: string | null): string {
  if (!code) return "";
  return `zamiennik za ${code}${name ? ` (${name})` : ""}`;
}

/**
 * „Podmień” — podgląd podziału pozycji listy (jak w funkcji SQL substitute_requirement_item): część oryginału JUŻ
 * wydana (wydano ponad zapotrzebowanie innych list) zostaje jako oryginał, reszta przechodzi na odpowiednik 1:1.
 * `needed` / `issued` — bilans oryginału na zleceniu (wszystkie listy ACTIVE), `itemQuantity` — ilość na tej liście.
 */
export function substituteSplit(itemQuantity: number, needed: number, issued: number): { keep: number; move: number } {
  const other = Math.max(needed - itemQuantity, 0);
  const keep = Math.min(itemQuantity, Math.max(issued - other, 0));
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return { keep: r(keep), move: r(itemQuantity - keep) };
}

/**
 * Zamiennik za materiał bez ułamków (M2c w bazie: NOT_INTEGER) — błąd ilości do pokazania przed wysłaniem;
 * null, gdy ilość jest dopuszczalna dla oryginału.
 */
export function substituteQuantityError(quantity: number, original: { code: string; allowsFraction: boolean }): string | null {
  if (original.allowsFraction || Number.isInteger(quantity)) return null;
  return `${original.code} liczy się w całych jednostkach — zamiennik za niego wydaj w całych jednostkach`;
}

/** Domyślny kandydat „Policz jako zamiennik za”: pierwszy (największe pozostało), dla którego ilość jest dopuszczalna; "" = zwykłe wydanie. */
export function defaultSubstituteChoice(candidates: { id: string; code: string; allowsFraction: boolean }[], quantity: number): string {
  return candidates.find((c) => substituteQuantityError(quantity, c) === null)?.id ?? "";
}
