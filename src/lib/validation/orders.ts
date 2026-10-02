import { z } from "zod";
import { MAX_SEARCH_LENGTH } from "./catalog";

// Zlecenia produkcyjne (Etap 5 — wersja prosta). Nazwa NIEunikalna (np. nazwisko klienta).

export const ORDER_STATUSES = ["OPEN", "IN_PRODUCTION", "DONE", "CANCELLED"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  OPEN: "Otwarte",
  IN_PRODUCTION: "W produkcji",
  DONE: "Zakończone",
  CANCELLED: "Anulowane",
};

/** Statusy, dla których można wydawać materiał i dodawać listy zapotrzebowania. */
export const ISSUABLE_STATUSES: readonly OrderStatus[] = ["OPEN", "IN_PRODUCTION"];

export const MAX_ORDER_NAME_LENGTH = 120;
export const MAX_ORDER_NUMBER_LENGTH = 50;
export const MAX_ORDER_NOTES_LENGTH = 500;

const nameSchema = z
  .string({ error: "Podaj nazwę zlecenia" })
  .trim()
  .min(1, { error: "Podaj nazwę zlecenia" })
  .max(MAX_ORDER_NAME_LENGTH, { error: `Nazwa może mieć maksymalnie ${MAX_ORDER_NAME_LENGTH} znaków` });

const numberSchema = z
  .string({ error: "Numer: nieprawidłowa wartość" })
  .trim()
  .max(MAX_ORDER_NUMBER_LENGTH, { error: `Numer może mieć maksymalnie ${MAX_ORDER_NUMBER_LENGTH} znaków` })
  .transform((v) => (v === "" ? null : v))
  .nullable();

const notesSchema = z
  .string({ error: "Notatka: nieprawidłowa wartość" })
  .trim()
  .max(MAX_ORDER_NOTES_LENGTH, { error: `Notatka może mieć maksymalnie ${MAX_ORDER_NOTES_LENGTH} znaków` })
  .transform((v) => (v === "" ? null : v))
  .nullable();

const statusSchema = z.enum(ORDER_STATUSES, { error: "Nieprawidłowy status zlecenia" });

export const createOrderSchema = z
  .object({ name: nameSchema, number: numberSchema.optional(), notes: notesSchema.optional() })
  .strict();
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const updateOrderSchema = z
  .object({
    name: nameSchema.optional(),
    number: numberSchema.optional(),
    notes: notesSchema.optional(),
    status: statusSchema.optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { error: "Brak zmian do zapisania" });
export type UpdateOrderInput = z.infer<typeof updateOrderSchema>;

/**
 * Filtr statusu listy zleceń: konkretny status albo `ISSUABLE` (Otwarte + W produkcji — do wydania). Brak = wszystkie.
 */
export const ORDER_STATUS_FILTERS = [...ORDER_STATUSES, "ISSUABLE"] as const;
export type OrderStatusFilter = (typeof ORDER_STATUS_FILTERS)[number];

/** GET /api/v1/orders?status=OPEN&q=&page=&pageSize= — najnowsze pierwsze; `q` szuka po nazwie i numerze. */
export const listOrdersQuerySchema = z.object({
  status: z.enum(ORDER_STATUS_FILTERS, { error: "Nieprawidłowy status zlecenia" }).optional(),
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

/** Nazwa zlecenia z numerem: „Z-12 · Kowalski” (bez numeru — sama nazwa). */
export function orderLabel(o: { name: string; number?: string | null }): string {
  return o.number ? `${o.number} · ${o.name}` : o.name;
}

/**
 * Wyróżnik zlecenia przy nazwach, które mogą się powtarzać: „nr Z-12 · utw. 02.10.2026, 14:05 · notatka” (numer, gdy jest)
 * (notatka skrócona do `maxNotes` znaków). Używany wszędzie, gdzie wybiera się lub pokazuje zlecenie.
 */
export function orderSubLabel(o: { createdAt: string; notes: string | null; number?: string | null }, maxNotes = 60): string {
  const date = `${o.number ? `nr ${o.number} · ` : ""}utw. ${ORDER_CREATED.format(new Date(o.createdAt))}`;
  if (!o.notes) return date;
  const notes = o.notes.length > maxNotes ? `${o.notes.slice(0, maxNotes)}…` : o.notes;
  return `${date} · ${notes}`;
}
