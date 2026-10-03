import { z } from "zod";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MAX_SEARCH_LENGTH, entityIdSchema } from "./catalog";

// Walidacja operacji magazynowych (wspólna dla UI i API). Ostateczną kontrolę robi funkcja DB
// (stock_receipt) — tu zapewniamy czytelne komunikaty i normalizację wejścia z polskiej klawiatury.

export const MAX_QUANTITY = 1_000_000;
export const MAX_QUANTITY_DECIMALS = 3;
export const MAX_DOCUMENT_REF_LENGTH = 100;
export const MAX_NOTE_LENGTH = 500;

/** Jednostki liczone w całych sztukach (jak app.unit_allows_fraction w DB). Wielkość liter bez znaczenia. */
const INTEGER_UNITS = new Set([
  "szt",
  "szt.",
  "sztuka",
  "sztanga",
  "opak",
  "opak.",
  "opakowanie",
  "kpl",
  "kpl.",
  "komplet",
  "para",
  "rolka",
]);

/** Podpowiedź „Dopuszcza ułamki” dla jednostki (ADMIN może ją zmienić). */
export function unitAllowsFraction(unit: string): boolean {
  return !INTEGER_UNITS.has(unit.trim().toLowerCase());
}

export type QuantityCheck = { ok: true; value: number } | { ok: false; message: string };

/**
 * Ilość z pola tekstowego lub JSON. Akceptuje przecinek jako separator dziesiętny ("1,5") i spacje
 * (także twarde) jako separator tysięcy ("1 000"). Wymaga > 0, ≤ MAX_QUANTITY, max 3 miejsc po przecinku;
 * gdy allowsFraction === false — liczby całkowitej.
 */
export function checkQuantity(raw: unknown, allowsFraction = true, opts: { allowZero?: boolean } = {}): QuantityCheck {
  let text: string;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return { ok: false, message: "Podaj ilość" };
    text = String(raw);
  } else if (typeof raw === "string") {
    text = raw.replace(/[\s\u00a0\u202f]/g, "");
    // "1.500" wygląda jak separator tysięcy z kropką — niejednoznaczne, prosimy o przecinek.
    if (/^\d{1,3}(\.\d{3})+$/.test(text)) {
      return { ok: false, message: "Użyj przecinka dla części dziesiętnej (np. 1,5), bez kropek w tysiącach" };
    }
    text = text.replace(",", ".");
  } else {
    return { ok: false, message: "Podaj ilość" };
  }
  if (text === "") return { ok: false, message: "Podaj ilość" };
  const positiveMessage = opts.allowZero ? "Ilość nie może być ujemna" : "Ilość musi być większa od zera";
  if (/^-\d/.test(text)) return { ok: false, message: positiveMessage };
  const match = /^(\d*)(?:\.(\d+))?$/.exec(text); // także ",5" / ".5" → 0,5
  if (!match || (match[1] === "" && match[2] === undefined)) return { ok: false, message: "Ilość musi być liczbą, np. 12 albo 2,5" };
  const decimals = match[2] ?? "";
  if (decimals.replace(/0+$/, "").length > MAX_QUANTITY_DECIMALS) {
    return { ok: false, message: `Ilość może mieć maksymalnie ${MAX_QUANTITY_DECIMALS} miejsca po przecinku` };
  }
  const value = Number(text);
  if (opts.allowZero ? !(value >= 0) : !(value > 0)) return { ok: false, message: "Ilość musi być większa od zera" };
  if (value > MAX_QUANTITY) return { ok: false, message: "Ilość może wynosić maksymalnie 1 000 000" };
  if (!allowsFraction && !Number.isInteger(value)) {
    return { ok: false, message: "Ten materiał liczy się w całych jednostkach (bez ułamków)" };
  }
  return { ok: true, value };
}

/** Schemat ilości (string z przecinkiem/kropką albo liczba) → liczba. */
export function quantitySchema(allowsFraction = true) {
  return z.union([z.string(), z.number()], { error: "Podaj ilość" }).transform((v, ctx) => {
    const result = checkQuantity(v, allowsFraction);
    if (!result.ok) {
      ctx.addIssue({ code: "custom", message: result.message });
      return z.NEVER;
    }
    return result.value;
  });
}

const optionalText = (label: string, max: number) =>
  z
    .string({ error: `${label}: nieprawidłowa wartość` })
    .trim()
    .max(max, { error: `${label} może mieć maksymalnie ${max} znaków` })
    .transform((v) => (v === "" ? null : v))
    .nullable();

/** POST /api/v1/stock/receipts. Całkowitość ilości (allows_fraction) sprawdza funkcja DB — zna materiał. */
export const receiptSchema = z
  .object({
    client_request_id: z.uuid({ error: "Brak identyfikatora żądania" }),
    location_id: z.uuid({ error: "Wybierz lokalizację" }),
    material_id: z.uuid({ error: "Wybierz materiał" }),
    quantity: quantitySchema(),
    supplier_id: z.uuid({ error: "Nieprawidłowy dostawca" }).nullable().optional(),
    document_ref: optionalText("Numer dokumentu", MAX_DOCUMENT_REF_LENGTH).optional(),
    note: optionalText("Notatka", MAX_NOTE_LENGTH).optional(),
  })
  .strict();
export type ReceiptInput = z.infer<typeof receiptSchema>;

// ---- wydanie ----------------------------------------------------------------
/** Powody wydania bez zlecenia (stała lista — CHECK w DB). INNY wymaga opisu. */
export const ISSUE_REASONS = ["SERWIS", "USZKODZENIE", "ZUZYCIE_WLASNE", "PROBKA", "INNY"] as const;
export type IssueReasonCode = (typeof ISSUE_REASONS)[number];
export const ISSUE_REASON_LABELS: Record<IssueReasonCode, string> = {
  SERWIS: "Serwis / reklamacja",
  USZKODZENIE: "Uszkodzenie",
  ZUZYCIE_WLASNE: "Zużycie własne",
  PROBKA: "Próbka",
  INNY: "Inny",
};
export const MAX_REASON_LENGTH = 200;
export const MIN_OVERRIDE_REASON_LENGTH = 3;

/** Etykieta powodu (nieznany kod → sam kod). */
export function issueReasonLabel(code: string | null | undefined): string {
  return code && code in ISSUE_REASON_LABELS ? ISSUE_REASON_LABELS[code as IssueReasonCode] : (code ?? "");
}

/**
 * POST /api/v1/stock/issues. Dokładnie jedno: production_order_id ALBO reason_code; INNY wymaga opisu (reason);
 * opis tylko przy wydaniu bez zlecenia. Status zlecenia i dostępność sprawdza funkcja DB (stock_issue).
 */
export const issueSchema = z
  .object({
    client_request_id: z.uuid({ error: "Brak identyfikatora żądania" }),
    location_id: z.uuid({ error: "Wybierz lokalizację" }),
    material_id: z.uuid({ error: "Wybierz materiał" }),
    quantity: quantitySchema(),
    production_order_id: z.uuid({ error: "Nieprawidłowe zlecenie" }).nullable().optional(),
    reason_code: z.enum(ISSUE_REASONS, { error: "Wybierz powód z listy" }).nullable().optional(),
    reason: optionalText("Opis powodu", MAX_REASON_LENGTH).optional(),
    note: optionalText("Notatka", MAX_NOTE_LENGTH).optional(),
    // Etap 11: wydanie mimo rezerwacji innych zleceń — tylko ADMIN (route handler → 403, funkcja DB → 42501).
    override_reservations: z.boolean({ error: "Nieprawidłowa wartość" }).optional(),
    override_reason: optionalText("Powód wydania mimo rezerwacji", MAX_REASON_LENGTH).optional(),
    // Etap 12b: wydanie zamiennika — materiał z zapotrzebowania zlecenia (XXX), za który wydajemy material_id (YYY).
    // Brak = zwykłe wydanie (baza NIE przypisuje zamiennika sama — podpowiedź jest w UI, ADR 017 H1).
    substitute_for: z.uuid({ error: "Nieprawidłowy materiał oryginalny" }).nullable().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.substitute_for && !v.production_order_id) {
      ctx.addIssue({ code: "custom", path: ["substitute_for"], message: "Zamiennik wskazuje się tylko przy wydaniu na zlecenie" });
    }
    if (v.substitute_for && v.substitute_for === v.material_id) {
      ctx.addIssue({ code: "custom", path: ["substitute_for"], message: "Zamiennik musi być innym materiałem niż oryginał" });
    }
    if (v.override_reservations && (!v.override_reason || v.override_reason.length < MIN_OVERRIDE_REASON_LENGTH)) {
      ctx.addIssue({ code: "custom", path: ["override_reason"], message: "Podaj powód wydania mimo rezerwacji (min. 3 znaki)" });
    }
    if (!v.override_reservations && v.override_reason) {
      ctx.addIssue({ code: "custom", path: ["override_reason"], message: "Powód podaje się tylko przy wydaniu mimo rezerwacji" });
    }
    const hasOrder = !!v.production_order_id;
    const hasReason = !!v.reason_code;
    if (hasOrder === hasReason) {
      ctx.addIssue({ code: "custom", path: ["production_order_id"], message: "Wybierz zlecenie albo powód wydania" });
      return;
    }
    if (hasOrder && v.reason) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "Opis powodu podaje się tylko przy wydaniu bez zlecenia" });
    }
    if (v.reason_code === "INNY" && !v.reason) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "Opisz powód wydania" });
    }
  });
export type IssueInput = z.infer<typeof issueSchema>;

// ---- przesunięcie -------------------------------------------------------------
/** POST /api/v1/stock/transfers. Skąd ≠ dokąd; aktywność lokalizacji docelowej i stan sprawdza DB. */
export const transferSchema = z
  .object({
    client_request_id: z.uuid({ error: "Brak identyfikatora żądania" }),
    material_id: z.uuid({ error: "Wybierz materiał" }),
    from_location_id: z.uuid({ error: "Wybierz lokalizację źródłową" }),
    to_location_id: z.uuid({ error: "Wybierz lokalizację docelową" }),
    quantity: quantitySchema(),
    note: optionalText("Notatka", MAX_NOTE_LENGTH).optional(),
  })
  .strict()
  .refine((v) => v.from_location_id !== v.to_location_id, {
    error: "Lokalizacja docelowa musi być inna niż źródłowa",
    path: ["to_location_id"],
  });
export type TransferInput = z.infer<typeof transferSchema>;

// ---- korekta (ADMIN) ---------------------------------------------------------
/** Powody korekty (stała lista — CHECK w DB per typ operacji). INNY wymaga opisu. */
export const ADJUSTMENT_REASONS = [
  "POMYLKA_PRZYJECIA",
  "POMYLKA_WYDANIA",
  "USZKODZENIE",
  "ZAGINIECIE",
  "ZNALEZIONE",
  "STAN_POCZATKOWY",
  "INNY",
] as const;
export type AdjustmentReasonCode = (typeof ADJUSTMENT_REASONS)[number];
export const ADJUSTMENT_REASON_LABELS: Record<AdjustmentReasonCode, string> = {
  POMYLKA_PRZYJECIA: "Pomyłka przy przyjęciu",
  POMYLKA_WYDANIA: "Pomyłka przy wydaniu",
  USZKODZENIE: "Uszkodzenie / zniszczenie",
  ZAGINIECIE: "Zaginięcie / kradzież",
  ZNALEZIONE: "Odnaleziony towar",
  STAN_POCZATKOWY: "Wprowadzenie stanu początkowego",
  INNY: "Inny",
};

/** Etykieta powodu wg typu operacji (wydanie / korekta); nieznany kod → sam kod. */
export function reasonLabel(type: string, code: string | null | undefined): string {
  if (!code) return "";
  if (type === "ADJUSTMENT") {
    return code in ADJUSTMENT_REASON_LABELS ? ADJUSTMENT_REASON_LABELS[code as AdjustmentReasonCode] : code;
  }
  return issueReasonLabel(code);
}

/** Stan (≥ 0, do 3 miejsc) — faktyczna ilość albo stan widziany przez ADMIN-a. */
const nonNegativeQuantity = z.union([z.string(), z.number()], { error: "Podaj ilość" }).transform((v, ctx) => {
  const result = checkQuantity(v, true, { allowZero: true });
  if (!result.ok) {
    ctx.addIssue({ code: "custom", message: result.message });
    return z.NEVER;
  }
  return result.value;
});

/**
 * POST /api/v1/stock/adjustments — „ustaw stan na X”. `expected_current` = stan, który ADMIN widział (wyścig →
 * 409 STOCK_CHANGED). Całkowitość (allows_fraction), różnicę 0 i aktywność sprawdza funkcja DB (stock_adjust).
 */
export const adjustmentSchema = z
  .object({
    client_request_id: z.uuid({ error: "Brak identyfikatora żądania" }),
    material_id: z.uuid({ error: "Wybierz materiał" }),
    location_id: z.uuid({ error: "Wybierz lokalizację" }),
    target_quantity: nonNegativeQuantity,
    expected_current: nonNegativeQuantity,
    reason_code: z.enum(ADJUSTMENT_REASONS, { error: "Wybierz powód korekty z listy" }),
    reason: optionalText("Opis powodu", MAX_REASON_LENGTH).optional(),
    note: optionalText("Notatka", MAX_NOTE_LENGTH).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.reason_code === "INNY" && !v.reason) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "Opisz powód korekty" });
    }
  });
export type AdjustmentInput = z.infer<typeof adjustmentSchema>;

// ---- storno (ADMIN) ----------------------------------------------------------
export const MIN_REVERSAL_REASON_LENGTH = 3;

/** POST /api/v1/stock/reversals — cofnięcie operacji z obowiązkowym powodem (≥ 3 znaki). */
export const reversalSchema = z
  .object({
    client_request_id: z.uuid({ error: "Brak identyfikatora żądania" }),
    operation_id: z.uuid({ error: "Nieprawidłowa operacja" }),
    reason: z
      .string({ error: "Podaj powód cofnięcia" })
      .trim()
      .min(MIN_REVERSAL_REASON_LENGTH, { error: `Powód cofnięcia: co najmniej ${MIN_REVERSAL_REASON_LENGTH} znaki` })
      .max(MAX_REASON_LENGTH, { error: `Powód może mieć maksymalnie ${MAX_REASON_LENGTH} znaków` }),
    note: optionalText("Notatka", MAX_NOTE_LENGTH).optional(),
  })
  .strict();
export type ReversalInput = z.infer<typeof reversalSchema>;

const searchParam = z
  .string()
  .trim()
  .max(MAX_SEARCH_LENGTH, { error: `Szukana fraza może mieć maksymalnie ${MAX_SEARCH_LENGTH} znaków` })
  .optional()
  .transform((v) => (v ? v : undefined));

const boolParam = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => v === "true" || v === "1");

/** GET /api/v1/stock — stany (bez wierszy z zerem). Filtry: kategoria, tylko materiały poniżej minimum. */
export const listStockQuerySchema = z.object({
  locationId: entityIdSchema.optional(),
  materialId: entityIdSchema.optional(),
  categoryId: entityIdSchema.optional(),
  belowMin: boolParam,
  q: searchParam,
  page: z.coerce.number().int().min(1).max(100_000).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(500).optional().default(100),
});
export type ListStockQuery = Omit<z.infer<typeof listStockQuerySchema>, "q" | "belowMin"> & {
  q?: string;
  belowMin?: boolean;
};

/** Widok „suma per materiał” (strona Magazyn). */
export const listTotalsQuerySchema = z.object({
  categoryId: entityIdSchema.optional(),
  belowMin: boolParam,
  q: searchParam,
  page: z.coerce.number().int().min(1).max(100_000).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(500).optional().default(50),
});
export type ListTotalsQuery = Omit<z.infer<typeof listTotalsQuerySchema>, "q" | "belowMin"> & {
  q?: string;
  belowMin?: boolean;
  /** Mobilne SZUKAJ: wszystkie aktywne materiały (także bez stanu), zamiast „stan > 0 albo poniżej minimum”. */
  allActive?: boolean;
};

/** GET /api/v1/stock/export — eksport CSV; te same filtry co widok Magazyn. */
export const EXPORT_VARIANTS = ["location", "material"] as const;
export const exportStockQuerySchema = z.object({
  variant: z.enum(EXPORT_VARIANTS, { error: "Wariant eksportu: location albo material" }),
  categoryId: entityIdSchema.optional(),
  belowMin: boolParam,
  q: searchParam,
});
export type ExportStockQuery = Omit<z.infer<typeof exportStockQuerySchema>, "q"> & { q?: string };

export const OPERATION_TYPES = ["RECEIPT", "ISSUE", "TRANSFER", "ADJUSTMENT", "INVENTORY", "REVERSAL"] as const;
export type OperationType = (typeof OPERATION_TYPES)[number];
export const OPERATION_TYPE_LABELS: Record<OperationType, string> = {
  RECEIPT: "Przyjęcie",
  ISSUE: "Wydanie",
  TRANSFER: "Przesunięcie",
  ADJUSTMENT: "Korekta",
  INVENTORY: "Inwentaryzacja",
  REVERSAL: "Cofnięcie",
};
/** Typy do wyboru w filtrze historii. */
export const HISTORY_TYPES: OperationType[] = ["RECEIPT", "ISSUE", "TRANSFER", "ADJUSTMENT", "INVENTORY", "REVERSAL"];

const dateParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { error: "Data w formacie RRRR-MM-DD" })
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), { error: "Nieprawidłowa data" })
  .optional();

/** GET /api/v1/stock/operations — lista ruchów z danymi operacji (Przyjęcia; później historia). */
export const listMovementsQuerySchema = z
  .object({
    type: z.enum(OPERATION_TYPES, { error: "Nieprawidłowy typ operacji" }).optional(),
    q: searchParam,
    from: dateParam,
    to: dateParam,
    orderId: entityIdSchema.optional(),
    page: z.coerce.number().int().min(1).max(100_000).optional().default(1),
    pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional().default(DEFAULT_PAGE_SIZE),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { error: "Data „od” nie może być późniejsza niż „do”", path: ["to"] });
export type ListMovementsQuery = Omit<z.infer<typeof listMovementsQuerySchema>, "q"> & {
  q?: string;
  materialId?: string;
  locationId?: string;
  userId?: string;
  operationId?: string;
};

/**
 * GET /api/v1/stock/movements — historia ruchów: typ, materiał (fraza albo id), lokalizacja, użytkownik,
 * zlecenie, operacja (z jej stornem), zakres dat, strona. PRODUKCJA — tylko własne (wymusza baza).
 */
export const historyQuerySchema = z
  .object({
    type: z.enum(OPERATION_TYPES, { error: "Nieprawidłowy typ operacji" }).optional(),
    q: searchParam,
    materialId: entityIdSchema.optional(),
    locationId: entityIdSchema.optional(),
    userId: entityIdSchema.optional(),
    orderId: entityIdSchema.optional(),
    operationId: entityIdSchema.optional(),
    from: dateParam,
    to: dateParam,
    page: z.coerce.number().int().min(1).max(100_000).optional().default(1),
    pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional().default(DEFAULT_PAGE_SIZE),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { error: "Data „od” nie może być późniejsza niż „do”", path: ["to"] });
export type HistoryQuery = Omit<z.infer<typeof historyQuerySchema>, "q"> & { q?: string };

/** Ilość z jednostką, np. "2,5 mb", "3 szt.". */
export function formatQuantityUnit(value: number, unit: string): string {
  return `${formatQuantity(value)} ${unit}`;
}

/** Kończy zdanie kropką, chyba że już się nią kończy (jednostka "szt." → bez "szt.."). */
export function endSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** Ilość do wyświetlenia (pl-PL: przecinek dziesiętny, max 3 miejsca). */
export function formatQuantity(value: number): string {
  return value.toLocaleString("pl-PL", { maximumFractionDigits: MAX_QUANTITY_DECIMALS });
}
