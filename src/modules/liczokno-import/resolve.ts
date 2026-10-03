import { type SubstituteOption } from "@/lib/substitutes";
import { checkQuantity } from "@/lib/validation/stock";
import { cut, normalizeUnit, numberText, round3, type AggregatedItem } from "./normalize";

// Budowa podglądu importu: pozycje z pliku + wynik dopasowania kodów (resolve_import_codes) + decyzje użytkownika
// → pozycje ze statusem, ilością na listę (po przeliczeniu jednostek) i odwołaniem do źródła. Czyste funkcje.

/** Materiał z kartoteki (z resolve_import_codes albo z wyszukiwarki materiałów). */
export type ResolvedMaterial = {
  id: string;
  code: string;
  name: string;
  unit: string;
  allowsFraction: boolean;
  /** Długość sztangi [m] — pozwala przeliczyć metry z pliku na sztangi. */
  barLengthM: number | null;
  active: boolean;
  /** Etap 12b: wolne w magazynie (z resolve_import_codes; brak dla materiału z wyszukiwarki). */
  free?: number;
  /** Etap 12b: aktywne odpowiedniki z wolnym stanem. */
  substitutes?: SubstituteOption[];
};

export type CodeResolutionStatus = "ALIAS_MAP" | "IGNORED" | "MATERIAL" | "UNKNOWN";
export type CodeResolution = {
  code: string;
  status: CodeResolutionStatus;
  /** Id powiązania (MAP / IGNORE) albo null. */
  aliasId: string | null;
  material: ResolvedMaterial | null;
};

/** Decyzja użytkownika dla pozycji (klucz = znormalizowany kod). */
export type ItemOverride = {
  /** „Wskaż materiał” (bez zapamiętywania powiązania). */
  material?: ResolvedMaterial;
  /** „Pomiń tylko teraz”. */
  skip?: boolean;
  /** Ilość wpisana ręcznie (tekst z pola; przecinek dziesiętny akceptowany). */
  quantityText?: string;
};

export type PreviewStatus =
  | "OK"
  | "PRZELICZONO"
  | "RECZNIE"
  | "NIEZNANY"
  | "NIE_MAGAZYNUJEMY"
  | "PROFIL_POMINIETY"
  | "BLAD_JEDNOSTKI"
  | "NIEAKTYWNY"
  | "NIE_CALKOWITA"
  | "BLAD_ILOSCI"
  | "POMINIETY_RECZNIE";

export type StatusGroup = "ready" | "resolve" | "skipped";

export const STATUS_META: Record<PreviewStatus, { label: string; group: StatusGroup }> = {
  OK: { label: "Gotowe", group: "ready" },
  PRZELICZONO: { label: "Przeliczono", group: "ready" },
  RECZNIE: { label: "Ręcznie", group: "ready" },
  NIEZNANY: { label: "Nieznany kod", group: "resolve" },
  BLAD_JEDNOSTKI: { label: "Niezgodna jednostka", group: "resolve" },
  NIEAKTYWNY: { label: "Materiał nieaktywny", group: "resolve" },
  NIE_CALKOWITA: { label: "Ilość niecałkowita", group: "resolve" },
  BLAD_ILOSCI: { label: "Błędna ilość", group: "resolve" },
  NIE_MAGAZYNUJEMY: { label: "Pominięty — nie magazynujemy", group: "skipped" },
  PROFIL_POMINIETY: { label: "Pominięty — profile", group: "skipped" },
  POMINIETY_RECZNIE: { label: "Pominięty tylko teraz", group: "skipped" },
};

export type PreviewItem = {
  key: string;
  code: string;
  description: string;
  fileQuantity: number;
  fileUnit: string;
  group: string | null;
  isProfile: boolean;
  sourceRows: number[];
  material: ResolvedMaterial | null;
  status: PreviewStatus;
  /** Wyjaśnienie statusu / błędu (np. „Niezgodna jednostka (plik: m, kartoteka: szt.)”). */
  message: string | null;
  /** Ilość proponowana automatycznie (z pliku albo po przeliczeniu); null, gdy nie da się ustalić. */
  suggestedQuantity: number | null;
  /** Ilość trafiająca na listę (ręczna, gdy poprawna; inaczej proponowana); null — pozycja niegotowa. */
  quantity: number | null;
  /** Błąd ręcznie wpisanej ilości. */
  quantityError: string | null;
  /** Przeliczenie do pokazania w podglądzie, np. „44,2 m → 7 szt.” (po ręcznej zmianie ilości — tylko jako propozycja). */
  conversion: string | null;
  /** Ilość wpisana ręcznie (poprawna). */
  manual: boolean;
  /** Suma metrów z pliku, gdy ilość wynika z przeliczenia m → sztangi (bez ręcznej zmiany); inaczej null. */
  meters: number | null;
  /** Pozycja trafi na listę. */
  ready: boolean;
  /** raw_source_ref (≤ 200 znaków) — źródło pozycji w pliku. */
  rawSourceRef: string;
};

export const MAX_RAW_SOURCE_REF = 200;
/** Tolerancja przy ceil(m / długość sztangi): 13,0 / 6,5 = 2 (nie 3). */
const CEIL_EPSILON = 1e-9;

function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${cut(text, max - 1)}…`;
}

/** Odwołanie do pliku: „LiczOkno: KOD w. 123, 124: 44,2 m” (≤ 200 znaków). */
export function buildRawSourceRef(item: Pick<AggregatedItem, "code" | "sourceRows" | "quantity" | "unit">): string {
  const rows = item.sourceRows.length === 1 ? `w. ${item.sourceRows[0]}` : `w. ${item.sourceRows.join(", ")}`;
  return truncate(`LiczOkno: ${item.code} ${rows}: ${numberText(item.quantity)} ${item.unit}`, MAX_RAW_SOURCE_REF);
}

type Computed = {
  status: PreviewStatus;
  message: string | null;
  quantity: number | null;
  conversion: string | null;
  meters: number | null;
};

/** Ilość na listę z sumy z pliku wg reguł jednostek (decyzja użytkownika nr 5, ADR 016). */
function computeQuantity(item: AggregatedItem, material: ResolvedMaterial): Computed {
  const fileUnit = normalizeUnit(item.unit);
  const materialUnit = normalizeUnit(material.unit);
  let quantity: number;
  let status: PreviewStatus = "OK";
  let conversion: string | null = null;
  let meters: number | null = null;

  if (fileUnit === materialUnit) {
    quantity = round3(item.quantity);
  } else if (fileUnit === "m" && material.barLengthM !== null && material.barLengthM > 0) {
    quantity = Math.ceil(item.quantity / material.barLengthM - CEIL_EPSILON);
    status = "PRZELICZONO";
    meters = item.quantity;
    conversion = `${numberText(item.quantity)} ${item.unit.trim()} → ${quantity} ${material.unit}`;
  } else {
    return {
      status: "BLAD_JEDNOSTKI",
      message: `Niezgodna jednostka (plik: ${item.unit.trim()}, kartoteka: ${material.unit})`,
      quantity: null,
      conversion: null,
      meters: null,
    };
  }

  if (!(quantity > 0)) {
    return { status: "BLAD_ILOSCI", message: "Ilość po zaokrągleniu wynosi 0", quantity: null, conversion, meters: null };
  }
  // Ilość ułamkowa dla materiału bez ułamków (allows_fraction=false) — do ręcznej poprawy.
  if (!material.allowsFraction && !Number.isInteger(quantity)) {
    return {
      status: "NIE_CALKOWITA",
      message: `Ilość ${numberText(quantity)} nie jest całkowita, a materiał liczy się w całych jednostkach`,
      quantity: null,
      conversion,
      meters: null,
    };
  }
  const check = checkQuantity(quantity, material.allowsFraction);
  if (!check.ok) return { status: "BLAD_ILOSCI", message: check.message, quantity: null, conversion, meters: null };
  return { status, message: null, quantity: check.value, conversion, meters };
}

function emptyItem(item: AggregatedItem, partial: Partial<PreviewItem> & Pick<PreviewItem, "status">): PreviewItem {
  return {
    key: item.key,
    code: item.code,
    description: item.description,
    fileQuantity: item.quantity,
    fileUnit: item.unit,
    group: item.group,
    isProfile: item.isProfile,
    sourceRows: item.sourceRows,
    material: null,
    message: null,
    suggestedQuantity: null,
    quantity: null,
    quantityError: null,
    conversion: null,
    manual: false,
    meters: null,
    ready: false,
    rawSourceRef: buildRawSourceRef(item),
    ...partial,
  };
}

/**
 * Podgląd importu. Kolejność decyzji: pominięcie ręczne → „nie magazynujemy” → profile (gdy wyłączone) →
 * materiał (wskazany albo z dopasowania; brak = nieznany) → nieaktywny → różne jednostki w pliku →
 * przeliczenie ilości. Ręczna ilość (poprawna) odblokowuje pozycję z błędem jednostki/ułamka.
 */
export function buildPreview(
  items: readonly AggregatedItem[],
  resolutions: ReadonlyMap<string, CodeResolution>,
  options: { includeProfiles: boolean },
  overrides: ReadonlyMap<string, ItemOverride> = new Map(),
): PreviewItem[] {
  return items.map((item) => {
    const override = overrides.get(item.key);
    const resolution = resolutions.get(item.key);

    if (override?.skip) return emptyItem(item, { status: "POMINIETY_RECZNIE" });
    if (!override?.material && resolution?.status === "IGNORED") return emptyItem(item, { status: "NIE_MAGAZYNUJEMY" });
    if (item.isProfile && !options.includeProfiles) return emptyItem(item, { status: "PROFIL_POMINIETY" });

    const material = override?.material ?? resolution?.material ?? null;
    if (!material) return emptyItem(item, { status: "NIEZNANY", message: "Kodu nie ma w kartotece" });
    if (!material.active) {
      return emptyItem(item, { material, status: "NIEAKTYWNY", message: `Materiał ${material.code} jest nieaktywny — wskaż inny albo pomiń` });
    }

    const computed: Computed = item.unitConflict
      ? {
          status: "BLAD_JEDNOSTKI",
          message: `Ten kod ma w pliku różne jednostki (${item.fileUnits.join(", ")}) — pomiń albo wpisz ilość ręcznie`,
          quantity: null,
          conversion: null,
          meters: null,
        }
      : computeQuantity(item, material);
    let status = computed.status;
    let message = computed.message;
    let quantity = computed.quantity;
    let quantityError: string | null = null;
    let manual = false;
    let meters = computed.meters;

    const typed = override?.quantityText?.trim() ?? "";
    if (typed !== "") {
      const check = checkQuantity(typed, material.allowsFraction);
      if (check.ok) {
        // Wpisana wartość równa propozycji nie jest zmianą ręczną.
        if (check.value !== computed.quantity) {
          manual = true;
          status = "RECZNIE";
          meters = null;
        }
        quantity = check.value;
        message = null;
      } else {
        quantity = null;
        quantityError = check.message;
        status = "BLAD_ILOSCI";
        message = check.message;
      }
    }

    return emptyItem(item, {
      material,
      status,
      message,
      suggestedQuantity: computed.quantity,
      quantity,
      quantityError,
      conversion: computed.conversion,
      manual,
      meters: manual ? null : meters,
      ready: quantity !== null && (status === "OK" || status === "PRZELICZONO" || status === "RECZNIE"),
    });
  });
}

export function summarizePreview(preview: readonly PreviewItem[]): { ready: number; toResolve: number; skipped: number } {
  const out = { ready: 0, toResolve: 0, skipped: 0 };
  for (const p of preview) {
    const group = STATUS_META[p.status].group;
    if (group === "ready") out.ready++;
    else if (group === "resolve") out.toResolve++;
    else out.skipped++;
  }
  return out;
}

/** Kolejność wyświetlania: pozycje wymagające decyzji, potem gotowe, potem pominięte (stabilnie wg pliku). */
export function sortRank(status: PreviewStatus): number {
  const group = STATUS_META[status].group;
  return group === "resolve" ? 0 : group === "ready" ? 1 : 2;
}

export type ImportItemPayload = { material_id: string; quantity: number; raw_source_ref: string };

/**
 * Pozycje do wysłania na serwer. Kilka pozycji pliku może wskazywać ten sam materiał (np. dwa kody powiązane z jednym
 * materiałem) — lista ma materiał raz, więc pozycje są scalane (`merged` = ile pozycji scalono), a odwołania łączone.
 * Gdy WSZYSTKIE scalane pozycje są w metrach przeliczonych na sztangi (bez ręcznej zmiany), metry są sumowane PRZED
 * zaokrągleniem w górę: ceil(Σm / długość) — nie suma osobnych ceil. Przy mieszanych jednostkach/ręcznych ilościach
 * sumowane są ilości policzone per kod.
 */
export function buildImportItems(preview: readonly PreviewItem[]): { items: ImportItemPayload[]; merged: number } {
  const groups = new Map<string, PreviewItem[]>();
  for (const p of preview) {
    if (!p.ready || p.quantity === null || !p.material) continue;
    const list = groups.get(p.material.id);
    if (list) list.push(p);
    else groups.set(p.material.id, [p]);
  }
  const items: ImportItemPayload[] = [];
  let merged = 0;
  for (const [materialId, list] of groups) {
    if (list.length === 1) {
      items.push({ material_id: materialId, quantity: list[0].quantity as number, raw_source_ref: list[0].rawSourceRef });
      continue;
    }
    merged += list.length - 1;
    const bar = list[0].material?.barLengthM ?? null;
    let quantity: number;
    if (bar !== null && bar > 0 && list.every((p) => p.meters !== null)) {
      const totalMeters = Number(list.reduce((sum, p) => sum + (p.meters as number), 0).toFixed(6));
      quantity = Math.ceil(totalMeters / bar - CEIL_EPSILON);
    } else {
      quantity = round3(list.reduce((sum, p) => sum + (p.quantity as number), 0));
    }
    const refs = list.map((p, idx) => (idx === 0 ? p.rawSourceRef : p.rawSourceRef.replace(/^LiczOkno:\s*/, "")));
    items.push({ material_id: materialId, quantity, raw_source_ref: truncate(refs.join(" | "), MAX_RAW_SOURCE_REF) });
  }
  return { items, merged };
}

const plQty = (n: number) => n.toLocaleString("pl-PL", { maximumFractionDigits: 3 });

/**
 * Etap 12b — informacja (nie blokada) przy pozycji gotowej, gdy ilość na listę > wolne: „Na stanie wolne: N —
 * odpowiednik YYY: M” (tylko odpowiedniki z wolnym > 0). Podmiana odbywa się po zapisie, w Brakach zlecenia.
 * null — brak informacji (pozycja niegotowa, wolne nieznane albo wystarczające).
 */
export function availabilityInfo(item: Pick<PreviewItem, "ready" | "quantity" | "material">): string | null {
  const m = item.material;
  if (!item.ready || item.quantity === null || !m || m.free === undefined || item.quantity <= m.free) return null;
  const subs = (m.substitutes ?? []).filter((s) => s.free > 0);
  const base = `Na stanie wolne: ${plQty(m.free)} ${m.unit}`;
  if (subs.length === 0) return base;
  return `${base} — ${subs.length === 1 ? "odpowiednik" : "odpowiedniki"} ${subs.map((s) => `${s.code}: ${plQty(s.free)} ${s.unit}`).join(", ")} (podmiana po zapisie — w Brakach zlecenia)`;
}
