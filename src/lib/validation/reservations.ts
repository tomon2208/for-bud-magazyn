import { z } from "zod";
import { formatQuantity, quantitySchema } from "./stock";

// Rezerwacje materiału dla zleceń — Etap 11 (ADR 014). Ostateczna kontrola (wolne, pozostało do zarezerwowania,
// ułamki, status zlecenia, rola) w funkcjach DB reserve_for_order / release_reservation.

export const MAX_RESERVE_ITEMS = 500;
export const MAX_RELEASE_REASON_LENGTH = 200;

/** POST /api/v1/orders/[id]/reservations — `items` puste/brak = automatycznie dla wszystkich pozycji. */
export const reserveSchema = z
  .object({
    client_request_id: z.uuid({ error: "Brak identyfikatora żądania" }),
    items: z
      .array(
        z
          .object({
            material_id: z.uuid({ error: "Wybierz materiał" }),
            quantity: quantitySchema(),
          })
          .strict(),
        { error: "Nieprawidłowe pozycje" },
      )
      .min(1, { error: "Podaj co najmniej jedną pozycję" })
      .max(MAX_RESERVE_ITEMS, { error: `Maksymalnie ${MAX_RESERVE_ITEMS} pozycji` })
      .nullable()
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    (v.items ?? []).forEach((item, i) => {
      if (seen.has(item.material_id)) {
        ctx.addIssue({ code: "custom", path: ["items", i, "material_id"], message: "Ten materiał występuje więcej niż raz" });
      }
      seen.add(item.material_id);
    });
  });
export type ReserveInput = z.infer<typeof reserveSchema>;

/** POST /api/v1/orders/[id]/reservations/release — bez materiału = całe zlecenie; bez ilości = cała rezerwacja materiału. */
export const releaseSchema = z
  .object({
    client_request_id: z.uuid({ error: "Brak identyfikatora żądania" }),
    material_id: z.uuid({ error: "Nieprawidłowy materiał" }).nullable().optional(),
    quantity: quantitySchema().nullable().optional(),
    reason: z
      .string({ error: "Powód: nieprawidłowa wartość" })
      .trim()
      .max(MAX_RELEASE_REASON_LENGTH, { error: `Powód: maksymalnie ${MAX_RELEASE_REASON_LENGTH} znaków` })
      .transform((v) => (v === "" ? null : v))
      .nullable()
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.quantity != null && !v.material_id) {
      ctx.addIssue({ code: "custom", path: ["quantity"], message: "Ilość podaje się tylko przy zwalnianiu jednego materiału" });
    }
  });
export type ReleaseInput = z.infer<typeof releaseSchema>;

/** GET /api/v1/stock/availability?materialId=&orderId= */
export const availabilityQuerySchema = z.object({
  materialId: z.uuid({ error: "Nieprawidłowy materiał" }),
  orderId: z.uuid({ error: "Nieprawidłowe zlecenie" }).optional(),
});

/**
 * Domyślna ilość „Zarezerwuj” dla pozycji: min(pozostało do zarezerwowania, wolne), całkowita dla materiałów
 * bez ułamków (jak w reserve_for_order). Używana w podpowiedzi pola ilości.
 */
export function suggestReserveQuantity(toReserve: number, free: number, allowsFraction: boolean): number {
  const q = Math.max(0, Math.min(toReserve, free));
  const rounded = Math.round(q * 1000) / 1000;
  return allowsFraction ? rounded : Math.floor(rounded);
}

/**
 * Review Etapu 11 (M1b): ile rezerwacji przekroczy zapotrzebowanie po wycofaniu listy (rezerwacje się NIE zmieniają).
 * Nadmiar = zarezerwowane − max(potrzebne − ilość z listy − wydano, 0).
 */
export function excessAfterWithdraw(
  r: { items: { materialId: string; quantity: number }[] },
  reservations: { materialId: string; materialCode: string; unit: string; reserved: number; needed: number; issued: number }[],
): string[] {
  const out: string[] = [];
  for (const item of r.items) {
    const res = reservations.find((x) => x.materialId === item.materialId);
    if (!res || res.reserved <= 0) continue;
    const remainingAfter = Math.max(res.needed - item.quantity - res.issued, 0);
    const excess = Math.round((res.reserved - remainingAfter) * 1000) / 1000;
    if (excess > 0) out.push(`${res.materialCode}: ${formatQuantity(excess)} ${res.unit}`);
  }
  return out;
}
