import { z } from "zod";
import { entityIdSchema } from "./catalog";
import { quantitySchema } from "./stock";

// Zapotrzebowanie (listy niezmienne, sumowane) i braki — Etap 8–10 (ADR 013).

export const MAX_REQUIREMENT_NAME_LENGTH = 120;
export const MAX_REQUIREMENT_ITEMS = 500;
export const MAX_ITEM_NOTE_LENGTH = 200;
export const MIN_WITHDRAW_REASON_LENGTH = 3;
export const MAX_WITHDRAW_REASON_LENGTH = 200;

const itemNote = z
  .string({ error: "Notatka: nieprawidłowa wartość" })
  .trim()
  .max(MAX_ITEM_NOTE_LENGTH, { error: `Notatka pozycji: maksymalnie ${MAX_ITEM_NOTE_LENGTH} znaków` })
  .transform((v) => (v === "" ? null : v))
  .nullable();

export const requirementItemSchema = z
  .object({
    material_id: z.uuid({ error: "Wybierz materiał" }),
    // Ułamki wg allows_fraction materiału sprawdza baza (NOT_INTEGER); tu: > 0, ≤ 1 000 000, ≤ 3 miejsca.
    quantity: quantitySchema(),
    note: itemNote.optional(),
  })
  .strict();

/** POST /api/v1/orders/[id]/requirements — nowa lista (1–500 pozycji, materiał raz). */
export const createRequirementSchema = z
  .object({
    name: z
      .string({ error: "Podaj nazwę listy" })
      .trim()
      .min(1, { error: "Podaj nazwę listy" })
      .max(MAX_REQUIREMENT_NAME_LENGTH, { error: `Nazwa listy: maksymalnie ${MAX_REQUIREMENT_NAME_LENGTH} znaków` }),
    items: z
      .array(requirementItemSchema, { error: "Dodaj pozycje listy" })
      .min(1, { error: "Dodaj co najmniej jedną pozycję" })
      .max(MAX_REQUIREMENT_ITEMS, { error: `Lista może mieć maksymalnie ${MAX_REQUIREMENT_ITEMS} pozycji` }),
    client_request_id: z.uuid({ error: "Nieprawidłowy identyfikator żądania" }).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.items.forEach((item, i) => {
      if (seen.has(item.material_id)) {
        ctx.addIssue({ code: "custom", path: ["items", i, "material_id"], message: "Ten materiał jest już na liście" });
      }
      seen.add(item.material_id);
    });
  });
export type CreateRequirementInput = z.infer<typeof createRequirementSchema>;

/** POST /api/v1/requirements/[id]/withdraw */
export const withdrawRequirementSchema = z
  .object({
    reason: z
      .string({ error: "Podaj powód wycofania" })
      .trim()
      .min(MIN_WITHDRAW_REASON_LENGTH, { error: `Powód wycofania: minimum ${MIN_WITHDRAW_REASON_LENGTH} znaki` })
      .max(MAX_WITHDRAW_REASON_LENGTH, { error: `Powód wycofania: maksymalnie ${MAX_WITHDRAW_REASON_LENGTH} znaków` }),
  })
  .strict();
export type WithdrawRequirementInput = z.infer<typeof withdrawRequirementSchema>;

const boolParam = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => v === "true" || v === "1");

/** GET /api/v1/shortages i /shortages/export. `onlyShort` — tylko materiały z brakiem (domyślnie wszystkie z zapotrzebowaniem). */
export const shortagesQuerySchema = z.object({
  supplier: entityIdSchema.optional(),
  category: entityIdSchema.optional(),
  onlyShort: boolParam,
});
export type ShortagesQuery = z.infer<typeof shortagesQuerySchema>;

