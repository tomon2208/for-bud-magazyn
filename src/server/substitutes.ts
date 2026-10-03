import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ServiceError, ServiceResult } from "./users";

// Odpowiedniki materiałów (Etap 12b, ADR 017): pary symetryczne, nieprzechodnie, 1:1. Zapis — funkcje DB
// add_material_substitute / remove_material_substitute (tylko ADMIN, 42501 → 403); odczyt — każda aktywna rola.

type Db = SupabaseClient;
type DbError = { code?: string; message?: string; hint?: string | null; details?: string | null };

const INTERNAL: ServiceError = { status: 500, code: "INTERNAL", message: "Wystąpił błąd serwera. Spróbuj ponownie." };

export function mapSubstituteError(error: DbError, context: string): ServiceError {
  if (error.code === "42501") return { status: 403, code: "FORBIDDEN", message: "Brak uprawnień" };
  if (error.code === "P0001" && error.hint) {
    switch (error.hint) {
      case "NOT_FOUND":
        return {
          status: 404,
          code: "NOT_FOUND",
          message: error.details === "substitute" ? "Nie znaleziono pary odpowiedników" : "Nie znaleziono materiału",
        };
      case "SAME_MATERIAL":
        return { status: 400, code: "SAME_MATERIAL", message: "Materiał nie może być odpowiednikiem samego siebie" };
      case "MATERIAL_INACTIVE":
        return {
          status: 400,
          code: "MATERIAL_INACTIVE",
          message: `Materiał${error.details ? ` ${error.details}` : ""} jest nieaktywny`,
        };
      case "VALIDATION":
        return { status: 400, code: "VALIDATION", message: "Nieprawidłowe dane" };
    }
  }
  if (error.code === "22P02" || error.code === "23514") return { status: 400, code: "VALIDATION", message: "Nieprawidłowe dane" };
  console.error(context, error.code ?? "unknown");
  return INTERNAL;
}

export type MaterialSubstituteDto = {
  /** Id pary (do usunięcia). */
  id: string;
  materialId: string;
  materialCode: string;
  materialName: string;
  unit: string;
  active: boolean;
  stockActive: number;
  reserved: number;
  free: number;
  createdAt: string;
};
type MaterialSubstituteRow = {
  id: string;
  material_id: string;
  material_code: string;
  material_name: string;
  unit: string;
  active: boolean;
  stock_active: number | string | null;
  reserved: number | string | null;
  free: number | string | null;
  created_at: string;
};

/** Odpowiedniki materiału (karta materiału) — także nieaktywne, z wolnym stanem. */
export async function listMaterialSubstitutes(db: Db, materialId: string): Promise<ServiceResult<MaterialSubstituteDto[]>> {
  const { data, error } = await db.rpc("material_substitute_list", { p_material_id: materialId });
  if (error) return { ok: false, error: mapSubstituteError(error, "listMaterialSubstitutes") };
  return {
    ok: true,
    data: ((data ?? []) as MaterialSubstituteRow[]).map((r) => ({
      id: r.id,
      materialId: r.material_id,
      materialCode: r.material_code,
      materialName: r.material_name,
      unit: r.unit,
      active: r.active,
      stockActive: Number(r.stock_active ?? 0),
      reserved: Number(r.reserved ?? 0),
      free: Number(r.free ?? 0),
      createdAt: r.created_at,
    })),
  };
}

export type AddedSubstituteDto = { id: string; alreadyExisted: boolean };

/** Dodanie pary (ADMIN). Istniejąca para — sukces z alreadyExisted = true. */
export async function addMaterialSubstitute(db: Db, materialId: string, substituteId: string): Promise<ServiceResult<AddedSubstituteDto>> {
  const { data, error } = await db.rpc("add_material_substitute", { p_material_id: materialId, p_substitute_id: substituteId });
  if (error || !data) return { ok: false, error: mapSubstituteError(error ?? {}, "addMaterialSubstitute") };
  const r = data as { id: string; already_existed: boolean };
  return { ok: true, data: { id: r.id, alreadyExisted: r.already_existed === true } };
}

/** Usunięcie pary (ADMIN). Nie zmienia rozliczeń historycznych (zapisane w operacjach). */
export async function removeMaterialSubstitute(db: Db, pairId: string): Promise<ServiceResult<{ id: string }>> {
  const { error } = await db.rpc("remove_material_substitute", { p_id: pairId });
  if (error) return { ok: false, error: mapSubstituteError(error, "removeMaterialSubstitute") };
  return { ok: true, data: { id: pairId } };
}
