import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ImportRequirementInput, ResolveCodesInput, UpsertAliasInput } from "@/lib/validation/import";
import { mapRequirementError } from "./requirements";
import type { ServiceResult } from "./users";

// Import zapotrzebowania z LiczOkno (Etap 12a, ADR 016). Plik jest parsowany w przeglądarce; tu: dopasowanie kodów
// (resolve_import_codes), powiązania kodów / lista „nie magazynujemy” (import_code_aliases) i zapis listy IMPORT
// (import_requirement). Klient UŻYTKOWNIKA; role BIURO/ADMIN egzekwują funkcje DB (42501 → 403).

type Db = SupabaseClient;

export type ResolvedCodeStatus = "ALIAS_MAP" | "IGNORED" | "MATERIAL" | "UNKNOWN";
export type ResolvedCodeMaterialDto = {
  id: string;
  code: string;
  name: string;
  unit: string;
  allowsFraction: boolean;
  barLengthM: number | null;
  active: boolean;
};
export type ResolvedCodeDto = {
  code: string;
  status: ResolvedCodeStatus;
  /** Id powiązania (MAP / IGNORE) — do cofnięcia oznaczenia „nie magazynujemy”. */
  aliasId: string | null;
  material: ResolvedCodeMaterialDto | null;
};
type ResolvedCodeRow = {
  code: string;
  status: ResolvedCodeStatus;
  alias_id: string | null;
  material_id: string | null;
  material_code: string | null;
  material_name: string | null;
  unit: string | null;
  allows_fraction: boolean | null;
  bar_length_m: number | string | null;
  active: boolean | null;
};

/** Dopasowanie kodów z pliku do kartoteki (powiązanie → kod materiału → nieznany) — jeden round-trip. */
export async function resolveImportCodes(db: Db, input: ResolveCodesInput): Promise<ServiceResult<ResolvedCodeDto[]>> {
  const { data, error } = await db.rpc("resolve_import_codes", { p_codes: input.codes });
  if (error) return { ok: false, error: mapRequirementError(error, "resolveImportCodes") };
  return {
    ok: true,
    data: ((data ?? []) as ResolvedCodeRow[]).map((r) => ({
      code: r.code,
      status: r.status,
      aliasId: r.alias_id,
      material:
        r.material_id === null
          ? null
          : {
              id: r.material_id,
              code: r.material_code ?? "",
              name: r.material_name ?? "",
              unit: r.unit ?? "",
              allowsFraction: r.allows_fraction ?? true,
              barLengthM: r.bar_length_m === null ? null : Number(r.bar_length_m),
              active: r.active ?? false,
            },
    })),
  };
}

export type ImportAliasDto = {
  id: string;
  sourceCode: string;
  action: "MAP" | "IGNORE";
  materialId: string | null;
  materialCode: string | null;
  materialName: string | null;
  materialUnit: string | null;
  materialActive: boolean | null;
  updatedAt: string;
};
type AliasRow = {
  id: string;
  source_code: string;
  action: "MAP" | "IGNORE";
  material_id: string | null;
  updated_at: string;
  material: { code: string; name: string; unit: string; active: boolean } | null;
};

const ALIAS_LIMIT = 5000;

/** Powiązania kodów i lista „nie magazynujemy” (BIURO, ADMIN — RLS). `total` > items.length = obcięte. */
export async function listImportAliases(db: Db): Promise<ServiceResult<{ items: ImportAliasDto[]; total: number }>> {
  const { data, error, count } = await db
    .from("import_code_aliases")
    .select("id, source_code, action, material_id, updated_at, material:materials(code, name, unit, active)", { count: "exact" })
    .order("source_code", { ascending: true })
    .limit(ALIAS_LIMIT);
  if (error) return { ok: false, error: mapRequirementError(error, "listImportAliases") };
  return {
    ok: true,
    data: {
      total: count ?? 0,
      items: (data as unknown as AliasRow[]).map((r) => ({
        id: r.id,
        sourceCode: r.source_code,
        action: r.action,
        materialId: r.material_id,
        materialCode: r.material?.code ?? null,
        materialName: r.material?.name ?? null,
        materialUnit: r.material?.unit ?? null,
        materialActive: r.material?.active ?? null,
        updatedAt: r.updated_at,
      })),
    },
  };
}

export type UpsertedAliasDto = { id: string; sourceCode: string; action: "MAP" | "IGNORE"; materialId: string | null };

/** Zapis powiązania (MAP) albo oznaczenia „nie magazynujemy” (IGNORE); upsert po kodzie. */
export async function upsertImportAlias(db: Db, input: UpsertAliasInput): Promise<ServiceResult<UpsertedAliasDto>> {
  const { data, error } = await db.rpc("upsert_import_alias", {
    p_source_code: input.source_code,
    p_action: input.action,
    p_material_id: input.material_id ?? null,
  });
  if (error || !data) return { ok: false, error: mapRequirementError(error ?? {}, "upsertImportAlias") };
  const r = data as { id: string; source_code: string; action: "MAP" | "IGNORE"; material_id: string | null };
  return { ok: true, data: { id: r.id, sourceCode: r.source_code, action: r.action, materialId: r.material_id } };
}

/** Usunięcie powiązania / oznaczenia (to konfiguracja, nie historia). */
export async function deleteImportAlias(db: Db, id: string): Promise<ServiceResult<{ id: string }>> {
  const { error } = await db.rpc("delete_import_alias", { p_id: id });
  if (error) return { ok: false, error: mapRequirementError(error, "deleteImportAlias") };
  return { ok: true, data: { id } };
}

export type ImportedRequirementDto = {
  orderId: string;
  requirementId: string;
  itemCount: number;
  orderCreated: boolean;
  idempotentReplay: boolean;
};

/** Lista IMPORT do istniejącego zlecenia albo nowe zlecenie + lista (jedna transakcja). BIURO, ADMIN. */
export async function importRequirement(db: Db, input: ImportRequirementInput): Promise<ServiceResult<ImportedRequirementDto>> {
  const { data, error } = await db.rpc("import_requirement", {
    p_order_id: input.order_id ?? null,
    p_new_order: input.new_order ? { name: input.new_order.name, number: input.new_order.number ?? null } : null,
    p_name: input.name,
    p_file_name: input.file_name,
    p_import_format: input.import_format,
    p_items: input.items.map((i) => ({
      material_id: i.material_id,
      quantity: i.quantity,
      raw_source_ref: i.raw_source_ref ?? null,
    })),
    p_client_request_id: input.client_request_id,
  });
  if (error || !data) return { ok: false, error: mapRequirementError(error ?? {}, "importRequirement") };
  const r = data as { order_id: string; requirement_id: string; item_count: number; order_created: boolean; idempotent_replay: boolean };
  return {
    ok: true,
    data: {
      orderId: r.order_id,
      requirementId: r.requirement_id,
      itemCount: Number(r.item_count),
      orderCreated: r.order_created === true,
      idempotentReplay: r.idempotent_replay === true,
    },
  };
}
