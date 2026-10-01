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
export function checkQuantity(raw: unknown, allowsFraction = true): QuantityCheck {
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
  if (/^-\d/.test(text)) return { ok: false, message: "Ilość musi być większa od zera" };
  const match = /^(\d*)(?:\.(\d+))?$/.exec(text); // także ",5" / ".5" → 0,5
  if (!match || (match[1] === "" && match[2] === undefined)) return { ok: false, message: "Ilość musi być liczbą, np. 12 albo 2,5" };
  const decimals = match[2] ?? "";
  if (decimals.replace(/0+$/, "").length > MAX_QUANTITY_DECIMALS) {
    return { ok: false, message: `Ilość może mieć maksymalnie ${MAX_QUANTITY_DECIMALS} miejsca po przecinku` };
  }
  const value = Number(text);
  if (!(value > 0)) return { ok: false, message: "Ilość musi być większa od zera" };
  if (value > MAX_QUANTITY) return { ok: false, message: "Ilość może wynosić maksymalnie 1 000 000" };
  if (!allowsFraction && !Number.isInteger(value)) {
    return { ok: false, message: "Ten materiał przyjmuje się w całych jednostkach (bez ułamków)" };
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

const searchParam = z
  .string()
  .trim()
  .max(MAX_SEARCH_LENGTH, { error: `Szukana fraza może mieć maksymalnie ${MAX_SEARCH_LENGTH} znaków` })
  .optional()
  .transform((v) => (v ? v : undefined));

/** GET /api/v1/stock — stany (bez wierszy z zerem). */
export const listStockQuerySchema = z.object({
  locationId: entityIdSchema.optional(),
  materialId: entityIdSchema.optional(),
  q: searchParam,
  page: z.coerce.number().int().min(1).max(100_000).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(500).optional().default(100),
});
export type ListStockQuery = Omit<z.infer<typeof listStockQuerySchema>, "q"> & { q?: string };

export const OPERATION_TYPES = ["RECEIPT", "ISSUE", "TRANSFER", "ADJUSTMENT", "INVENTORY"] as const;
export type OperationType = (typeof OPERATION_TYPES)[number];

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
    page: z.coerce.number().int().min(1).max(100_000).optional().default(1),
    pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional().default(DEFAULT_PAGE_SIZE),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { error: "Data „od” nie może być późniejsza niż „do”", path: ["to"] });
export type ListMovementsQuery = Omit<z.infer<typeof listMovementsQuerySchema>, "q"> & { q?: string };

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
