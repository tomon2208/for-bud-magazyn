import { z } from "zod";
import { entityIdSchema, materialCodeSchema } from "./catalog";
import { MAX_ORDER_NAME_LENGTH, MAX_ORDER_NUMBER_LENGTH } from "./orders";
import { MAX_REQUIREMENT_ITEMS, MAX_REQUIREMENT_NAME_LENGTH } from "./requirements";
import { quantitySchema } from "./stock";

// Import zapotrzebowania z LiczOkno (Etap 12a, ADR 016). Plik jest parsowany w przeglądarce — API przyjmuje
// wyłącznie znormalizowany JSON (kody, pozycje z przeliczoną ilością).

export const MAX_RESOLVE_CODES = 1000;
export const MAX_FILE_NAME_LENGTH = 255;
export const MAX_IMPORT_FORMAT_LENGTH = 100;
export const MAX_RAW_REF_LENGTH = 200;

/** POST /api/v1/import/resolve — kody z pliku do dopasowania (normalizację robi baza). */
export const resolveCodesSchema = z
  .object({
    codes: z
      .array(z.string({ error: "Kod musi być tekstem" }).trim().min(1, { error: "Pusty kod" }).max(200, { error: "Kod jest za długi" }), {
        error: "Podaj kody do dopasowania",
      })
      .min(1, { error: "Podaj co najmniej jeden kod" })
      .max(MAX_RESOLVE_CODES, { error: `Maksymalnie ${MAX_RESOLVE_CODES} kodów naraz` }),
  })
  .strict();
export type ResolveCodesInput = z.infer<typeof resolveCodesSchema>;

export const ALIAS_ACTIONS = ["MAP", "IGNORE"] as const;
export type AliasAction = (typeof ALIAS_ACTIONS)[number];

/** PUT /api/v1/import/aliases — MAP wymaga material_id, IGNORE go nie przyjmuje. */
export const upsertAliasSchema = z
  .object({
    source_code: materialCodeSchema,
    action: z.enum(ALIAS_ACTIONS, { error: "Nieprawidłowa akcja" }),
    material_id: entityIdSchema.nullable().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.action === "MAP" && !v.material_id) {
      ctx.addIssue({ code: "custom", path: ["material_id"], message: "Wskaż materiał" });
    }
    if (v.action === "IGNORE" && v.material_id) {
      ctx.addIssue({ code: "custom", path: ["material_id"], message: "Lista „nie magazynujemy” nie przyjmuje materiału" });
    }
  });
export type UpsertAliasInput = z.infer<typeof upsertAliasSchema>;

const orderName = z
  .string({ error: "Podaj nazwę zlecenia" })
  .trim()
  .min(1, { error: "Podaj nazwę zlecenia" })
  .max(MAX_ORDER_NAME_LENGTH, { error: `Nazwa może mieć maksymalnie ${MAX_ORDER_NAME_LENGTH} znaków` });

const orderNumber = z
  .string({ error: "Numer: nieprawidłowa wartość" })
  .trim()
  .max(MAX_ORDER_NUMBER_LENGTH, { error: `Numer może mieć maksymalnie ${MAX_ORDER_NUMBER_LENGTH} znaków` })
  .transform((v) => (v === "" ? null : v))
  .nullable();

const rawRef = z
  .string({ error: "Odwołanie do pliku: nieprawidłowa wartość" })
  .trim()
  .max(MAX_RAW_REF_LENGTH, { error: `Odwołanie do pliku: maksymalnie ${MAX_RAW_REF_LENGTH} znaków` })
  .transform((v) => (v === "" ? null : v))
  .nullable();

export const importItemSchema = z
  .object({
    material_id: z.uuid({ error: "Wybierz materiał" }),
    // Ułamki wg allows_fraction materiału sprawdza baza (NOT_INTEGER); tu: > 0, ≤ 1 000 000, ≤ 3 miejsca.
    quantity: quantitySchema(),
    raw_source_ref: rawRef.optional(),
  })
  .strict();

/**
 * POST /api/v1/import/requirements — lista IMPORT do istniejącego zlecenia (`order_id`) albo nowe zlecenie + lista
 * (`new_order`) tworzone atomowo. Dokładnie jedno z nich. `client_request_id` wymagany (idempotencja).
 */
export const importRequirementSchema = z
  .object({
    order_id: entityIdSchema.optional(),
    new_order: z.object({ name: orderName, number: orderNumber.optional() }).strict().optional(),
    name: z
      .string({ error: "Podaj nazwę listy" })
      .trim()
      .min(1, { error: "Podaj nazwę listy" })
      .max(MAX_REQUIREMENT_NAME_LENGTH, { error: `Nazwa listy: maksymalnie ${MAX_REQUIREMENT_NAME_LENGTH} znaków` }),
    file_name: z
      .string({ error: "Brak nazwy pliku" })
      .trim()
      .min(1, { error: "Brak nazwy pliku" })
      .max(MAX_FILE_NAME_LENGTH, { error: `Nazwa pliku: maksymalnie ${MAX_FILE_NAME_LENGTH} znaków` }),
    import_format: z
      .string({ error: "Brak formatu importu" })
      .trim()
      .min(1, { error: "Brak formatu importu" })
      .max(MAX_IMPORT_FORMAT_LENGTH, { error: `Format: maksymalnie ${MAX_IMPORT_FORMAT_LENGTH} znaków` }),
    items: z
      .array(importItemSchema, { error: "Dodaj pozycje listy" })
      .min(1, { error: "Dodaj co najmniej jedną pozycję" })
      .max(MAX_REQUIREMENT_ITEMS, { error: `Lista może mieć maksymalnie ${MAX_REQUIREMENT_ITEMS} pozycji` }),
    client_request_id: z.uuid({ error: "Nieprawidłowy identyfikator żądania" }),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.order_id === undefined) === (v.new_order === undefined)) {
      ctx.addIssue({ code: "custom", path: ["order_id"], message: "Podaj zlecenie albo dane nowego zlecenia (dokładnie jedno)" });
    }
    const seen = new Set<string>();
    v.items.forEach((item, i) => {
      if (seen.has(item.material_id)) {
        ctx.addIssue({ code: "custom", path: ["items", i, "material_id"], message: "Ten materiał jest już na liście" });
      }
      seen.add(item.material_id);
    });
  });
export type ImportRequirementInput = z.infer<typeof importRequirementSchema>;
