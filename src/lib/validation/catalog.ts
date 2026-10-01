import { z } from "zod";

/** Segmenty [A-Z0-9._/-] rozdzielone pojedynczą spacją, łącznie 1–50 znaków. */
export const MATERIAL_CODE_REGEX = /^(?=.{1,50}$)[A-Z0-9._/-]+( [A-Z0-9._/-]+)*$/;

/** Normalizacja kodu (jak w triggerze DB): białe znaki → jedna spacja, trim, UPPERCASE. */
export function normalizeMaterialCode(value: string): string {
  return value.replace(/\s+/g, " ").trim().toUpperCase();
}
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_SEARCH_LENGTH = 100;

/** Podpowiedzi jednostek w UI — pole jest tekstem, lista może rosnąć (ADR 007). */
export const UNIT_SUGGESTIONS = ["szt.", "sztanga", "mb", "opak.", "kg", "l", "m²"] as const;

const idSchema = (message: string) => z.uuid({ error: message });
export const entityIdSchema = idSchema("Nieprawidłowy identyfikator");

/** Kod materiału: przycięty i zamieniany na WIELKIE litery przed walidacją. */
export const materialCodeSchema = z
  .string({ error: "Podaj kod materiału" })
  .transform(normalizeMaterialCode)
  .pipe(
    z.string().regex(MATERIAL_CODE_REGEX, {
      error: "Kod: 1–50 znaków, litery A–Z, cyfry, . _ / - oraz pojedyncze spacje wewnątrz",
    }),
  );

const requiredName = (label: string, max: number) =>
  z
    .string({ error: `Podaj ${label}` })
    .trim()
    .min(1, { error: `Podaj ${label}` })
    .max(max, { error: `Maksymalnie ${max} znaków` });

/** Pole opcjonalne: pusty tekst → null (wyczyszczenie), brak pola → bez zmiany. */
const optionalText = (label: string, max: number) =>
  z
    .string({ error: `${label}: nieprawidłowa wartość` })
    .trim()
    .max(max, { error: `${label} może mieć maksymalnie ${max} znaków` })
    .transform((v) => (v === "" ? null : v))
    .nullable();

export const categoryNameSchema = requiredName("nazwę kategorii", 80);
export const supplierNameSchema = requiredName("nazwę dostawcy", 200);
export const materialNameSchema = requiredName("nazwę materiału", 200);
export const unitSchema = requiredName("jednostkę", 20);

const activeSchema = z.boolean({ error: "Pole active musi być typu logicznego" });
const allowsFractionSchema = z.boolean({ error: "Pole allows_fraction musi być typu logicznego" });
const nonEmptyPatch = (v: Record<string, unknown>) => Object.values(v).some((x) => x !== undefined);
const NO_CHANGES = { error: "Brak zmian do zapisania" };

// ---- kategorie -------------------------------------------------------------
export const createCategorySchema = z.object({ name: categoryNameSchema }).strict();
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z
  .object({ name: categoryNameSchema.optional(), active: activeSchema.optional() })
  .strict()
  .refine(nonEmptyPatch, NO_CHANGES);
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

// ---- dostawcy --------------------------------------------------------------
const supplierFields = {
  contact_person: optionalText("Osoba kontaktowa", 120),
  phone: optionalText("Telefon", 50),
  email: optionalText("E-mail", 200),
  notes: optionalText("Uwagi", 2000),
};

export const createSupplierSchema = z
  .object({
    name: supplierNameSchema,
    contact_person: supplierFields.contact_person.optional(),
    phone: supplierFields.phone.optional(),
    email: supplierFields.email.optional(),
    notes: supplierFields.notes.optional(),
  })
  .strict();
export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;

export const updateSupplierSchema = z
  .object({
    name: supplierNameSchema.optional(),
    contact_person: supplierFields.contact_person.optional(),
    phone: supplierFields.phone.optional(),
    email: supplierFields.email.optional(),
    notes: supplierFields.notes.optional(),
    active: activeSchema.optional(),
  })
  .strict()
  .refine(nonEmptyPatch, NO_CHANGES);
export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>;

// ---- materiały -------------------------------------------------------------
export const createMaterialSchema = z
  .object({
    code: materialCodeSchema,
    name: materialNameSchema,
    category_id: idSchema("Wybierz kategorię"),
    unit: unitSchema,
    // Brak pola → baza ustala wg jednostki (szt./sztanga/opak. → false).
    allows_fraction: allowsFractionSchema.optional(),
    default_supplier_id: idSchema("Nieprawidłowy dostawca").nullable().optional(),
    notes: optionalText("Uwagi", 2000).optional(),
  })
  .strict();
export type CreateMaterialInput = z.infer<typeof createMaterialSchema>;

export const updateMaterialSchema = z
  .object({
    code: materialCodeSchema.optional(),
    name: materialNameSchema.optional(),
    category_id: idSchema("Wybierz kategorię").optional(),
    unit: unitSchema.optional(),
    allows_fraction: allowsFractionSchema.optional(),
    default_supplier_id: idSchema("Nieprawidłowy dostawca").nullable().optional(),
    notes: optionalText("Uwagi", 2000).optional(),
    active: activeSchema.optional(),
  })
  .strict()
  .refine(nonEmptyPatch, NO_CHANGES);
export type UpdateMaterialInput = z.infer<typeof updateMaterialSchema>;

// ---- parametry list (query string) -------------------------------------------
const boolParam = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => v === "true" || v === "1");

const searchParam = z
  .string()
  .trim()
  .max(MAX_SEARCH_LENGTH, { error: `Szukana fraza może mieć maksymalnie ${MAX_SEARCH_LENGTH} znaków` })
  .optional()
  .transform((v) => (v ? v : undefined));

export const listCategoriesQuerySchema = z.object({ includeInactive: boolParam });

export const listSuppliersQuerySchema = z.object({ q: searchParam, includeInactive: boolParam });

export const listMaterialsQuerySchema = z.object({
  q: searchParam,
  categoryId: idSchema("Nieprawidłowa kategoria").optional(),
  includeInactive: boolParam,
  /** Tylko materiały ze stanem > 0 w jakiejkolwiek lokalizacji (wybór materiału przy wydaniu). */
  inStock: boolParam,
  page: z.coerce.number().int().min(1).max(100_000).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional().default(DEFAULT_PAGE_SIZE),
});
export type ListMaterialsQuery = Omit<z.infer<typeof listMaterialsQuerySchema>, "inStock"> & { inStock?: boolean };

/**
 * Wzorzec LIKE "zawiera" z dosłownym traktowaniem znaków specjalnych (`\`, `%`, `_`).
 * PostgREST zamienia `*` w wartościach like/ilike na `%` (alias wildcard), a nie da się go wyescapować —
 * dlatego `*` zastępujemy `_` (dopasuje dowolny pojedynczy znak, w tym `*`), żeby nie działał jak "dowolny ciąg".
 */
export function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, "\\$&").replace(/\*/g, "_")}%`;
}

/**
 * Wartość filtra `ilike` do wstawienia w PostgREST `.or("kolumna.ilike.<wartość>")`: wzorzec z `likeContains`
 * w cudzysłowie (przecinki, nawiasy, kropki i dwukropki nie rozbijają filtra), z escapowaniem `\` i `"`.
 */
export function buildIlikeContainsValue(term: string): string {
  return `"${likeContains(term).replace(/[\\"]/g, "\\$&")}"`;
}
