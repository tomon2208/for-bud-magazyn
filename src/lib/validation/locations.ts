import { z } from "zod";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MAX_SEARCH_LENGTH, entityIdSchema } from "./catalog";

/** Kod lokalizacji: 1–20 znaków [A-Z0-9._-], bez spacji i "/", co najmniej jedna litera/cyfra (ADR 008). */
export const LOCATION_CODE_REGEX = /^(?=.*[A-Z0-9])[A-Z0-9._-]{1,20}$/;
export const MAX_LOCATION_CODE_LENGTH = 20;
/** Prefiks treści QR: `L:<kod>`. Dwukropek nie należy do alfabetu kodów, więc prefiks jest jednoznaczny. */
export const QR_LOCATION_PREFIX = "L:";

/** Treść QR dla kodu lokalizacji (na etykiecie drukujemy sam kod). */
export const qrPayloadForLocation = (code: string) => `${QR_LOCATION_PREFIX}${code}`;
export const MAX_BULK_LOCATIONS = 200;

/** Normalizacja kodu (jak w triggerze DB): trim + UPPERCASE. Spacje wewnątrz zostają i kod zostanie odrzucony. */
export function normalizeLocationCode(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * Wynik skanu/ręcznego wpisu → znormalizowany kod albo null. Akceptuje `L:<kod>` (treść QR) oraz sam kod
 * (ręczny wpis). Inny prefiks (`X:…`), URL, pusty lub za długi tekst → null. Kod nigdy nie jest
 * wykonywany ani interpretowany, tylko porównywany z bazą.
 */
export function parseScannedCode(raw: string): string | null {
  let code = normalizeLocationCode(raw);
  if (code.startsWith(QR_LOCATION_PREFIX)) code = code.slice(QR_LOCATION_PREFIX.length);
  return LOCATION_CODE_REGEX.test(code) ? code : null;
}

/** Parametr ścieżki (`[code]`) → kod; zepsute kodowanie procentowe → null (404, nie 500). */
export function decodeCodeParam(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export const locationCodeSchema = z
  .string({ error: "Podaj kod lokalizacji" })
  .transform(normalizeLocationCode)
  .pipe(
    z.string().regex(LOCATION_CODE_REGEX, {
      error: "Kod: 1–20 znaków, litery A–Z, cyfry, . _ - (bez spacji)",
    }),
  );

const optionalText = (label: string, max: number) =>
  z
    .string({ error: `${label}: nieprawidłowa wartość` })
    .trim()
    .max(max, { error: `${label} może mieć maksymalnie ${max} znaków` })
    .transform((v) => (v === "" ? null : v))
    .nullable();

const nameSchema = optionalText("Nazwa", 100);
const descriptionSchema = optionalText("Opis", 500);
const activeSchema = z.boolean({ error: "Pole active musi być typu logicznego" });

export const createLocationSchema = z
  .object({
    code: locationCodeSchema,
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
  })
  .strict();
export type CreateLocationInput = z.infer<typeof createLocationSchema>;

export const updateLocationSchema = z
  .object({
    code: locationCodeSchema.optional(),
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
    active: activeSchema.optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { error: "Brak zmian do zapisania" });
export type UpdateLocationInput = z.infer<typeof updateLocationSchema>;

export const bulkLocationsSchema = z
  .object({
    items: z
      .array(z.object({ code: locationCodeSchema, name: nameSchema.optional() }).strict())
      .min(1, { error: "Podaj co najmniej jedną lokalizację" })
      .max(MAX_BULK_LOCATIONS, { error: `Maksymalnie ${MAX_BULK_LOCATIONS} lokalizacji naraz` }),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.items.forEach((item, index) => {
      if (seen.has(item.code)) {
        ctx.addIssue({ code: "custom", path: ["items", index, "code"], message: `Kod ${item.code} powtarza się na liście` });
      }
      seen.add(item.code);
    });
  });
export type BulkLocationsInput = z.infer<typeof bulkLocationsSchema>;

const boolParam = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => v === "true" || v === "1");

export const listLocationsQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .max(MAX_SEARCH_LENGTH, { error: `Szukana fraza może mieć maksymalnie ${MAX_SEARCH_LENGTH} znaków` })
    .optional()
    .transform((v) => (v ? v : undefined)),
  includeInactive: boolParam,
  page: z.coerce.number().int().min(1).max(100_000).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional().default(DEFAULT_PAGE_SIZE),
});
export type ListLocationsQuery = z.infer<typeof listLocationsQuerySchema>;

/** `?ids=a,b,c` strony etykiet: 1–200 unikalnych UUID. */
export const labelIdsSchema = z
  .string()
  .transform((v) => [...new Set(v.split(",").map((s) => s.trim()).filter(Boolean))])
  .pipe(z.array(entityIdSchema).min(1).max(MAX_BULK_LOCATIONS));

// ---- generator kodów seryjnych ------------------------------------------------

export type SeriesInput = {
  rack: string;
  shelfFrom: number;
  shelfTo: number;
  levelFrom: number;
  levelTo: number;
};
export type GeneratedLocation = { code: string; name: string };
export type SeriesResult = { ok: true; items: GeneratedLocation[] } | { ok: false; message: string };

const RACK_REGEX = /^[A-Z0-9]{1,10}$/;
const MAX_INDEX = 999;


/**
 * Generator kodów wg wzorca `<REGAŁ>-<PÓŁKA>-<POZIOM>`; zera wiodące do liczby cyfr maksimum zakresu (min. 2):
 * `A-01-01`, a przy półkach 1–120 `A-001-01` (kody sortują się leksykograficznie).
 * Kolejność: półka rosnąco, w niej poziom rosnąco. Limit: MAX_BULK_LOCATIONS pozycji.
 */
export function generateLocationSeries(input: SeriesInput): SeriesResult {
  const rack = input.rack.trim().toUpperCase();
  if (!RACK_REGEX.test(rack)) return { ok: false, message: "Regał: 1–10 znaków, litery A–Z i cyfry" };
  const ranges: [string, number, number][] = [
    ["Półki", input.shelfFrom, input.shelfTo],
    ["Poziomy", input.levelFrom, input.levelTo],
  ];
  for (const [label, from, to] of ranges) {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1 || from > MAX_INDEX || to > MAX_INDEX) {
      return { ok: false, message: `${label}: podaj liczby całkowite od 1 do ${MAX_INDEX}` };
    }
    if (from > to) return { ok: false, message: `${label}: wartość „od” nie może być większa niż „do”` };
  }
  const count = (input.shelfTo - input.shelfFrom + 1) * (input.levelTo - input.levelFrom + 1);
  if (count > MAX_BULK_LOCATIONS) {
    return { ok: false, message: `Za dużo lokalizacji (${count}). Maksymalnie ${MAX_BULK_LOCATIONS} naraz` };
  }
  const shelfWidth = Math.max(2, String(input.shelfTo).length);
  const levelWidth = Math.max(2, String(input.levelTo).length);
  const items: GeneratedLocation[] = [];
  for (let shelf = input.shelfFrom; shelf <= input.shelfTo; shelf++) {
    for (let level = input.levelFrom; level <= input.levelTo; level++) {
      items.push({
        code: `${rack}-${String(shelf).padStart(shelfWidth, "0")}-${String(level).padStart(levelWidth, "0")}`,
        name: `Regał ${rack}, półka ${shelf}, poziom ${level}`,
      });
    }
  }
  return { ok: true, items };
}
