import { z } from "zod";
import { MAX_SEARCH_LENGTH } from "./catalog";

// Zlecenia produkcyjne (Etap 5 — wersja prosta). Nazwa NIEunikalna (np. nazwisko klienta).

export const ORDER_STATUSES = ["OPEN", "DONE", "CANCELLED"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  OPEN: "Otwarte",
  DONE: "Zakończone",
  CANCELLED: "Anulowane",
};

export const MAX_ORDER_NAME_LENGTH = 120;
export const MAX_ORDER_NOTES_LENGTH = 500;

const nameSchema = z
  .string({ error: "Podaj nazwę zlecenia" })
  .trim()
  .min(1, { error: "Podaj nazwę zlecenia" })
  .max(MAX_ORDER_NAME_LENGTH, { error: `Nazwa może mieć maksymalnie ${MAX_ORDER_NAME_LENGTH} znaków` });

const notesSchema = z
  .string({ error: "Notatka: nieprawidłowa wartość" })
  .trim()
  .max(MAX_ORDER_NOTES_LENGTH, { error: `Notatka może mieć maksymalnie ${MAX_ORDER_NOTES_LENGTH} znaków` })
  .transform((v) => (v === "" ? null : v))
  .nullable();

const statusSchema = z.enum(ORDER_STATUSES, { error: "Nieprawidłowy status zlecenia" });

export const createOrderSchema = z.object({ name: nameSchema, notes: notesSchema.optional() }).strict();
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const updateOrderSchema = z
  .object({ name: nameSchema.optional(), notes: notesSchema.optional(), status: statusSchema.optional() })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { error: "Brak zmian do zapisania" });
export type UpdateOrderInput = z.infer<typeof updateOrderSchema>;

/** GET /api/v1/orders?status=OPEN&q=&page=&pageSize= — najnowsze pierwsze. */
export const listOrdersQuerySchema = z.object({
  status: statusSchema.optional(),
  q: z
    .string()
    .trim()
    .max(MAX_SEARCH_LENGTH, { error: `Szukana fraza może mieć maksymalnie ${MAX_SEARCH_LENGTH} znaków` })
    .optional()
    .transform((v) => (v ? v : undefined)),
  page: z.coerce.number().int().min(1).max(100_000).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(50),
});
export type ListOrdersQuery = Omit<z.infer<typeof listOrdersQuerySchema>, "q"> & { q?: string };

const ORDER_CREATED = new Intl.DateTimeFormat("pl-PL", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Warsaw",
});

/**
 * Wyróżnik zlecenia przy nazwach, które mogą się powtarzać: „utw. 02.10.2026, 14:05 · notatka”
 * (notatka skrócona do `maxNotes` znaków). Używany wszędzie, gdzie wybiera się lub pokazuje zlecenie.
 */
export function orderSubLabel(o: { createdAt: string; notes: string | null }, maxNotes = 60): string {
  const date = `utw. ${ORDER_CREATED.format(new Date(o.createdAt))}`;
  if (!o.notes) return date;
  const notes = o.notes.length > maxNotes ? `${o.notes.slice(0, maxNotes)}…` : o.notes;
  return `${date} · ${notes}`;
}
