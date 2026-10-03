import { z } from "zod";
import { checkQuantity, formatQuantity } from "./stock";

// Inwentaryzacja — Etap 13 (ADR 015). Ostateczna kontrola (role, status sesji, lokalizacje w otwartej sesji,
// ułamki, znacznik stanu → RECOUNT, nieaktywne tylko w dół) w funkcjach DB inventory_*.

export const MAX_SESSION_NAME_LENGTH = 120;
export const MAX_SESSION_NOTE_LENGTH = 500;
export const MAX_CODE_PREFIX_LENGTH = 20;
export const MAX_SESSION_LOCATIONS = 5000;
export const MAX_COUNT_ITEMS = 500;
export const MAX_APPROVE_IDS = 5000;
export const MAX_CANCEL_REASON_LENGTH = 200;

export const SESSION_STATUSES = ["OPEN", "CLOSED", "CANCELLED"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];
export const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
  OPEN: "Otwarta",
  CLOSED: "Zamknięta",
  CANCELLED: "Anulowana",
};

/** Status pozycji w tabeli zatwierdzania (inventory_session_review). */
export type ReviewStatus = "OK" | "DIFF" | "RECOUNT" | "APPROVED" | "MATCHED" | "UNCOUNTED";
export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  OK: "Zgodne",
  DIFF: "Różnica",
  RECOUNT: "Do ponownego policzenia",
  APPROVED: "Zatwierdzona różnica",
  MATCHED: "Zgodne — zatwierdzone",
  UNCOUNTED: "Niepoliczona",
};
export const BLOCKED_REASON_LABELS: Record<string, string> = {
  MATERIAL_INACTIVE: "Materiał nieaktywny — różnicy w górę nie można wprowadzić",
  LOCATION_INACTIVE: "Lokalizacja nieaktywna — różnicy w górę nie można wprowadzić",
  NOT_INTEGER: "Ilość ułamkowa dla materiału liczonego w całych jednostkach",
};
export const SKIP_REASON_LABELS: Record<string, string> = {
  ...BLOCKED_REASON_LABELS,
  ALREADY_APPROVED: "Pozycja była już zatwierdzona",
  COUNT_CHANGED: "Liczenie zmieniono po wczytaniu tabeli — sprawdź nową wartość i zatwierdź ponownie",
};

const uuid = (message: string) => z.uuid({ error: message });

/** POST /api/v1/inventory/sessions — dokładnie jeden sposób wyboru lokalizacji. */
export const createSessionSchema = z
  .object({
    client_request_id: uuid("Brak identyfikatora żądania"),
    name: z
      .string({ error: "Podaj nazwę sesji" })
      .trim()
      .min(1, { error: "Podaj nazwę sesji" })
      .max(MAX_SESSION_NAME_LENGTH, { error: `Nazwa: maksymalnie ${MAX_SESSION_NAME_LENGTH} znaków` }),
    note: z
      .string({ error: "Notatka: nieprawidłowa wartość" })
      .trim()
      .max(MAX_SESSION_NOTE_LENGTH, { error: `Notatka: maksymalnie ${MAX_SESSION_NOTE_LENGTH} znaków` })
      .transform((v) => (v === "" ? null : v))
      .nullable()
      .optional(),
    location_ids: z
      .array(uuid("Nieprawidłowa lokalizacja"), { error: "Nieprawidłowa lista lokalizacji" })
      .min(1, { error: "Zaznacz co najmniej jedną lokalizację" })
      .max(MAX_SESSION_LOCATIONS, { error: `Maksymalnie ${MAX_SESSION_LOCATIONS} lokalizacji` })
      .optional(),
    code_prefix: z
      .string({ error: "Prefiks: nieprawidłowa wartość" })
      .trim()
      .toUpperCase()
      .min(1, { error: "Podaj prefiks kodu" })
      .max(MAX_CODE_PREFIX_LENGTH, { error: `Prefiks: maksymalnie ${MAX_CODE_PREFIX_LENGTH} znaków` })
      .optional(),
    all_locations: z.literal(true, { error: "Nieprawidłowa wartość" }).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const modes = [v.location_ids !== undefined, v.code_prefix !== undefined, v.all_locations === true].filter(Boolean);
    if (modes.length !== 1) {
      ctx.addIssue({ code: "custom", path: ["location_ids"], message: "Wybierz lokalizacje: wszystkie, prefiks kodu albo zaznaczone" });
    }
  });
export type CreateSessionInput = z.infer<typeof createSessionSchema>;

/** Ilość policzona: 0 dozwolone („brak na półce”); przecinek dziesiętny. Ułamki — kontrola DB wg materiału. */
const countedQuantitySchema = z.union([z.string(), z.number()], { error: "Podaj ilość" }).transform((v, ctx) => {
  const r = checkQuantity(v, true, { allowZero: true });
  if (!r.ok) {
    ctx.addIssue({ code: "custom", message: r.message });
    return z.NEVER;
  }
  return r.value;
});

/** POST /api/v1/inventory/sessions/[id]/locations/[locationId]/count — pełny stan liczenia lokalizacji. */
export const saveCountSchema = z
  .object({
    client_request_id: uuid("Brak identyfikatora żądania"),
    started_at: z.iso.datetime({ offset: true, error: "Brak czasu rozpoczęcia liczenia" }),
    /** Wersja lokalizacji z ekranu liczenia — inna w bazie → 409 LOCATION_COUNT_CHANGED (ktoś zapisał w międzyczasie). */
    location_version: z.number({ error: "Brak wersji lokalizacji" }).int({ error: "Nieprawidłowa wersja" }).min(0, { error: "Nieprawidłowa wersja" }),
    items: z
      .array(
        z
          .object({
            material_id: uuid("Wybierz materiał"),
            quantity: countedQuantitySchema,
          })
          .strict(),
        { error: "Nieprawidłowe pozycje" },
      )
      .max(MAX_COUNT_ITEMS, { error: `Maksymalnie ${MAX_COUNT_ITEMS} pozycji` }),
  })
  .strict()
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.items.forEach((item, i) => {
      if (seen.has(item.material_id)) {
        ctx.addIssue({ code: "custom", path: ["items", i, "material_id"], message: "Ten materiał występuje więcej niż raz" });
      }
      seen.add(item.material_id);
    });
  });
export type SaveCountInput = z.infer<typeof saveCountSchema>;

/** POST .../approve — bez count_ids = wszystkie pozycje sesji. */
export const approveSchema = z
  .object({
    client_request_id: uuid("Brak identyfikatora żądania"),
    count_ids: z
      .array(uuid("Nieprawidłowa pozycja"), { error: "Nieprawidłowa lista pozycji" })
      .min(1, { error: "Zaznacz co najmniej jedną pozycję" })
      .max(MAX_APPROVE_IDS, { error: `Maksymalnie ${MAX_APPROVE_IDS} pozycji` })
      .nullable()
      .optional(),
    /** Ilości policzone, które widział zatwierdzający ({count_id: ilość}) — inna w bazie → pozycja pominięta (COUNT_CHANGED). */
    expected_counts: z
      .record(uuid("Nieprawidłowa pozycja"), z.number({ error: "Nieprawidłowa ilość" }).min(0).max(1_000_000), {
        error: "Nieprawidłowe ilości oczekiwane",
      })
      .optional(),
  })
  .strict();
export type ApproveInput = z.infer<typeof approveSchema>;

export const closeSessionSchema = z.object({ client_request_id: uuid("Brak identyfikatora żądania") }).strict();
export type CloseSessionInput = z.infer<typeof closeSessionSchema>;

export const cancelSessionSchema = z
  .object({
    client_request_id: uuid("Brak identyfikatora żądania"),
    reason: z
      .string({ error: "Powód: nieprawidłowa wartość" })
      .trim()
      .max(MAX_CANCEL_REASON_LENGTH, { error: `Powód: maksymalnie ${MAX_CANCEL_REASON_LENGTH} znaków` })
      .transform((v) => (v === "" ? null : v))
      .nullable()
      .optional(),
  })
  .strict();
export type CancelSessionInput = z.infer<typeof cancelSessionSchema>;

export const listSessionsQuerySchema = z.object({
  status: z.enum(SESSION_STATUSES, { error: "Nieprawidłowy status" }).optional(),
});

export const exportInventoryQuerySchema = z.object({
  onlyDiff: z
    .enum(["true", "false"], { error: "Nieprawidłowy parametr" })
    .transform((v) => v === "true")
    .optional(),
});

/** Pozycja, którą można zaznaczyć do zatwierdzenia: policzona, bez ruchu po liczeniu, bez blokady (OK → zgodne). */
export function isApprovable(r: { countId: string | null; status: ReviewStatus; blockedReason: string | null }): boolean {
  return r.countId !== null && (r.status === "DIFF" || r.status === "OK") && r.blockedReason === null;
}

/**
 * Ostrzeżenie o nadrezerwacji przed zatwierdzeniem (jak przy korekcie): per materiał Σ rezerwacji > stan w aktywnych
 * lokalizacjach po wprowadzeniu zaznaczonych różnic. Różnice w nieaktywnych lokalizacjach nie zmieniają „wolnego”.
 */
export function overReservationAfterApprove(
  rows: {
    materialId: string;
    materialCode: string;
    unit: string;
    locationActive: boolean;
    difference: number | null;
    materialStockActive: number;
    materialReserved: number;
  }[],
): string[] {
  const perMaterial = new Map<string, { code: string; unit: string; stock: number; reserved: number; delta: number }>();
  for (const r of rows) {
    const cur = perMaterial.get(r.materialId) ?? {
      code: r.materialCode,
      unit: r.unit,
      stock: r.materialStockActive,
      reserved: r.materialReserved,
      delta: 0,
    };
    if (r.locationActive && r.difference !== null) cur.delta += r.difference;
    perMaterial.set(r.materialId, cur);
  }
  const out: string[] = [];
  for (const m of perMaterial.values()) {
    const after = Math.round((m.stock + m.delta) * 1000) / 1000;
    if (m.delta < 0 && m.reserved > after) {
      out.push(`${m.code}: zarezerwowane ${formatQuantity(m.reserved)} ${m.unit}, stan po zatwierdzeniu ${formatQuantity(Math.max(after, 0))} ${m.unit}`);
    }
  }
  return out;
}
