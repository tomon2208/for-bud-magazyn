import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildIlikeContainsValue } from "@/lib/validation/catalog";
import {
  normalizeLocationCode,
  LOCATION_CODE_REGEX,
  type BulkLocationsInput,
  type CreateLocationInput,
  type ListLocationsQuery,
  type UpdateLocationInput,
} from "@/lib/validation/locations";
import type { ServiceError } from "./users";

// Serwis lokalizacji. Operacje idą przez klienta UŻYTKOWNIKA (RLS = druga linia obrony);
// rolę sprawdzają route handlery (requireApiRole).

type Db = SupabaseClient;
type DbError = { code?: string; message?: string; hint?: string | null };
/** `fields` — dodatkowe dane błędu (np. lista zajętych kodów przy imporcie seryjnym). */
export type LocationError = ServiceError & { fields?: Record<string, string[]> };
export type LocationResult<T> = { ok: true; data: T } | { ok: false; error: LocationError };

const INTERNAL: ServiceError = {
  status: 500,
  code: "INTERNAL",
  message: "Wystąpił błąd serwera. Spróbuj ponownie.",
};

const CODE_TAKEN: ServiceError = { status: 409, code: "CODE_TAKEN", message: "Lokalizacja o tym kodzie już istnieje" };

export function mapLocationDbError(error: DbError, context: string): ServiceError {
  if (error.code === "23505") return CODE_TAKEN;
  if (error.code === "42501") return { status: 403, code: "FORBIDDEN", message: "Brak uprawnień" };
  if (error.code === "P0001" && error.hint === "LOCATION_NOT_EMPTY") {
    return {
      status: 409,
      code: "LOCATION_NOT_EMPTY",
      message: "Nie można dezaktywować lokalizacji, w której jest towar. Najpierw przesuń lub wydaj materiał.",
    };
  }
  if (error.code === "23514" || error.code === "22P02") {
    return { status: 400, code: "VALIDATION", message: "Nieprawidłowe dane" };
  }
  console.error(context, error.code ?? "unknown");
  return INTERNAL;
}

export type LocationDto = {
  id: string;
  code: string;
  name: string | null;
  description: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};
type LocationRow = {
  id: string;
  code: string;
  name: string | null;
  description: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
};
const COLUMNS = "id, code, name, description, active, created_at, updated_at";

const toLocation = (r: LocationRow): LocationDto => ({
  id: r.id,
  code: r.code,
  name: r.name,
  description: r.description,
  active: r.active,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export type LocationPage = { items: LocationDto[]; total: number; page: number; pageSize: number };

const searchFilter = (q: string) => {
  const pattern = buildIlikeContainsValue(q);
  return `code.ilike.${pattern},name.ilike.${pattern}`;
};

export async function listLocations(db: Db, q: ListLocationsQuery): Promise<LocationResult<LocationPage>> {
  let query = db.from("locations").select(COLUMNS, { count: "exact" }).order("code", { ascending: true });
  if (!q.includeInactive) query = query.eq("active", true);
  if (q.q) query = query.or(searchFilter(q.q));
  const from = (q.page - 1) * q.pageSize;
  const { data, error, count } = await query.range(from, from + q.pageSize - 1);
  if (error) {
    // Strona poza zakresem (PGRST103): pusta strona z prawdziwym total, żeby UI przeszło na ostatnią.
    if (error.code === "PGRST103") {
      let countQuery = db.from("locations").select("id", { count: "exact", head: true });
      if (!q.includeInactive) countQuery = countQuery.eq("active", true);
      if (q.q) countQuery = countQuery.or(searchFilter(q.q));
      const { count: total, error: countError } = await countQuery;
      if (countError) return { ok: false, error: mapLocationDbError(countError, "listLocations count") };
      return { ok: true, data: { items: [], total: total ?? 0, page: q.page, pageSize: q.pageSize } };
    }
    return { ok: false, error: mapLocationDbError(error, "listLocations") };
  }
  return {
    ok: true,
    data: { items: (data as LocationRow[]).map(toLocation), total: count ?? 0, page: q.page, pageSize: q.pageSize },
  };
}

export async function getLocation(db: Db, id: string): Promise<LocationResult<LocationDto>> {
  const { data, error } = await db.from("locations").select(COLUMNS).eq("id", id).maybeSingle();
  if (error) return { ok: false, error: mapLocationDbError(error, "getLocation") };
  if (!data) return { ok: false, error: { status: 404, code: "NOT_FOUND", message: "Nie znaleziono lokalizacji" } };
  return { ok: true, data: toLocation(data as LocationRow) };
}

/** Lokalizacja po kodzie ze skanera. Kod jest normalizowany (trim, UPPERCASE); nieaktywna też jest zwracana. */
export async function getLocationByCode(db: Db, rawCode: string): Promise<LocationResult<LocationDto>> {
  const code = normalizeLocationCode(rawCode);
  const notFound: LocationResult<LocationDto> = {
    ok: false,
    error: { status: 404, code: "UNKNOWN_CODE", message: "Nieznany kod lokalizacji" },
  };
  if (!LOCATION_CODE_REGEX.test(code)) return notFound;
  const { data, error } = await db.from("locations").select(COLUMNS).eq("code", code).maybeSingle();
  if (error) return { ok: false, error: mapLocationDbError(error, "getLocationByCode") };
  if (!data) return notFound;
  return { ok: true, data: toLocation(data as LocationRow) };
}

/** Lokalizacje o podanych id (strona etykiet), posortowane po kodzie. */
export async function listLocationsByIds(db: Db, ids: string[]): Promise<LocationResult<LocationDto[]>> {
  const { data, error } = await db.from("locations").select(COLUMNS).in("id", ids).order("code", { ascending: true });
  if (error) return { ok: false, error: mapLocationDbError(error, "listLocationsByIds") };
  return { ok: true, data: (data as LocationRow[]).map(toLocation) };
}

export async function createLocation(db: Db, input: CreateLocationInput): Promise<LocationResult<LocationDto>> {
  const { data, error } = await db.from("locations").insert(input).select(COLUMNS).single();
  if (error || !data) return { ok: false, error: mapLocationDbError(error ?? {}, "createLocation") };
  return { ok: true, data: toLocation(data as LocationRow) };
}

export async function updateLocation(
  db: Db,
  id: string,
  input: UpdateLocationInput,
): Promise<LocationResult<LocationDto>> {
  const { data, error } = await db.from("locations").update(input).eq("id", id).select(COLUMNS).maybeSingle();
  if (error) return { ok: false, error: mapLocationDbError(error, "updateLocation") };
  if (!data) return { ok: false, error: { status: 404, code: "NOT_FOUND", message: "Nie znaleziono lokalizacji" } };
  return { ok: true, data: toLocation(data as LocationRow) };
}

/**
 * Dodawanie seryjne: JEDEN wielowierszowy INSERT = jedna instrukcja = jedna transakcja (wszystkie albo żadna).
 * Duplikat (unique code) → 409 z listą kodów, które już istnieją (odczyt informacyjny po nieudanym zapisie).
 */
export async function createLocationsBulk(db: Db, input: BulkLocationsInput): Promise<LocationResult<LocationDto[]>> {
  const { data, error } = await db.from("locations").insert(input.items).select(COLUMNS);
  if (error || !data) {
    if (error?.code === "23505") {
      const codes = input.items.map((i) => i.code);
      const { data: existing } = await db.from("locations").select("code").in("code", codes).order("code");
      const taken = (existing ?? []).map((r) => (r as { code: string }).code);
      const preview = taken.slice(0, 10).join(", ") + (taken.length > 10 ? ` (+${taken.length - 10})` : "");
      return {
        ok: false,
        error: {
          status: 409,
          code: "CODE_TAKEN",
          message: taken.length
            ? `Te kody już istnieją: ${preview}. Nic nie zapisano`
            : "Któryś z kodów już istnieje. Nic nie zapisano",
          fields: { codes: taken },
        },
      };
    }
    return { ok: false, error: mapLocationDbError(error ?? {}, "createLocationsBulk") };
  }
  const items = (data as LocationRow[]).map(toLocation).sort((a, b) => a.code.localeCompare(b.code));
  return { ok: true, data: items };
}
