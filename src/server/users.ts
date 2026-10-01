import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  loginToEmail,
  type AppRole,
  type CreateUserInput,
  type UpdateUserInput,
} from "@/lib/validation/auth";

/** Blokada logowania w Auth przy dezaktywacji (~100 lat). Źródłem prawdy jest profiles.active. */
const BAN_DURATION = "876000h";

export type UserDto = {
  id: string;
  login: string;
  fullName: string;
  role: AppRole;
  active: boolean;
  createdAt: string;
};

type ProfileRow = {
  id: string;
  login: string;
  full_name: string;
  role: AppRole;
  active: boolean;
  created_at: string;
};

const PROFILE_COLUMNS = "id, login, full_name, role, active, created_at";

export type ServiceError = { status: number; code: string; message: string };
export type ServiceResult<T> = { ok: true; data: T } | { ok: false; error: ServiceError };

const INTERNAL: ServiceError = {
  status: 500,
  code: "INTERNAL",
  message: "Wystąpił błąd serwera. Spróbuj ponownie.",
};

const LOGIN_TAKEN: ServiceError = {
  status: 409,
  code: "LOGIN_TAKEN",
  message: "Ten login jest już zajęty",
};

function toDto(row: ProfileRow): UserDto {
  return {
    id: row.id,
    login: row.login,
    fullName: row.full_name,
    role: row.role,
    active: row.active,
    createdAt: row.created_at,
  };
}

/** Lista użytkowników — przez klienta użytkownika (RLS: ADMIN widzi wszystkich). */
export async function listUsers(supabase: SupabaseClient): Promise<ServiceResult<UserDto[]>> {
  const { data, error } = await supabase
    .from("profiles")
    .select(PROFILE_COLUMNS)
    .order("login", { ascending: true });
  if (error) {
    console.error("listUsers", error.code);
    return { ok: false, error: INTERNAL };
  }
  return { ok: true, data: (data as ProfileRow[]).map(toDto) };
}

export function mapAuthError(err: { code?: string; status?: number }, context: string): ServiceError {
  if (err.code === "email_exists" || err.code === "user_already_exists") return LOGIN_TAKEN;
  if (err.code === "weak_password") {
    return {
      status: 400,
      code: "WEAK_PASSWORD",
      message: "Hasło jest zbyt słabe — użyj dłuższego hasła z literami i cyframi",
    };
  }
  if (err.code === "user_not_found") {
    return { status: 404, code: "NOT_FOUND", message: "Nie znaleziono użytkownika" };
  }
  console.error(context, err.code ?? "unknown", err.status ?? "");
  return INTERNAL;
}

export function isLastAdminError(err: { code?: string; hint?: string | null }) {
  return err.code === "P0001" && err.hint === "LAST_ADMIN";
}

/**
 * Tworzy konto w Supabase Auth. Profil powstaje atomowo w triggerze bazy na podstawie app_metadata
 * (app_metadata może ustawić wyłącznie klucz secret).
 */
export async function createUser(input: CreateUserInput): Promise<ServiceResult<UserDto>> {
  const admin = createSupabaseAdminClient();

  // Szybka, czytelna odpowiedź przy zajętym loginie (ostatecznie pilnuje unikalny e-mail w Auth).
  const { data: existing, error: existingError } = await admin
    .from("profiles")
    .select("id")
    .eq("login", input.login)
    .maybeSingle();
  if (existingError) {
    console.error("createUser: sprawdzenie loginu", existingError.code);
    return { ok: false, error: INTERNAL };
  }
  if (existing) return { ok: false, error: LOGIN_TAKEN };

  const { data, error } = await admin.auth.admin.createUser({
    email: loginToEmail(input.login),
    password: input.password,
    email_confirm: true,
    app_metadata: { login: input.login, full_name: input.full_name, role: input.role },
  });
  if (error || !data.user) {
    return { ok: false, error: error ? mapAuthError(error, "createUser") : INTERNAL };
  }

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select(PROFILE_COLUMNS)
    .eq("id", data.user.id)
    .single();
  if (profileError || !profile) {
    console.error("createUser: brak profilu po utworzeniu konta", profileError?.code);
    return { ok: false, error: INTERNAL };
  }
  return { ok: true, data: toDto(profile as ProfileRow) };
}

/**
 * Aktualizacja użytkownika. Kolejność kroków jest bezpieczna przy częściowej awarii:
 * 1. hasło — pierwsze, żeby błąd hasła (np. odrzucone przez Auth) nie zostawił zapisanych innych pól;
 * 2. aktywacja — najpierw zdjęcie bana, potem profiles.active=true;
 * 3. dezaktywacja — najpierw profiles.active=false (blokuje dostęp natychmiast), potem ban w Auth
 *    i unieważnienie wszystkich sesji (refresh tokenów).
 */
export async function updateUser(
  actorId: string,
  id: string,
  input: UpdateUserInput,
): Promise<ServiceResult<UserDto>> {
  if (actorId === id && (input.active === false || (input.role && input.role !== "ADMIN"))) {
    return {
      ok: false,
      error: {
        status: 409,
        code: "SELF_LOCKOUT",
        message: "Nie możesz dezaktywować swojego konta ani odebrać sobie roli administratora",
      },
    };
  }

  const admin = createSupabaseAdminClient();

  const { data: current, error: currentError } = await admin
    .from("profiles")
    .select(PROFILE_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (currentError) {
    console.error("updateUser: odczyt profilu", currentError.code);
    return { ok: false, error: INTERNAL };
  }
  if (!current) {
    return { ok: false, error: { status: 404, code: "NOT_FOUND", message: "Nie znaleziono użytkownika" } };
  }

  if (input.password !== undefined) {
    const { error } = await admin.auth.admin.updateUserById(id, { password: input.password });
    if (error) return { ok: false, error: mapAuthError(error, "updateUser: hasło") };
  }

  if (input.active === true) {
    const { error } = await admin.auth.admin.updateUserById(id, { ban_duration: "none" });
    if (error) return { ok: false, error: mapAuthError(error, "updateUser: unban") };
  }

  const patch: Partial<Pick<ProfileRow, "full_name" | "role" | "active">> = {};
  if (input.full_name !== undefined) patch.full_name = input.full_name;
  if (input.role !== undefined) patch.role = input.role;
  if (input.active !== undefined) patch.active = input.active;

  let row = current as ProfileRow;
  if (Object.keys(patch).length > 0) {
    const { data, error } = await admin
      .from("profiles")
      .update(patch)
      .eq("id", id)
      .select(PROFILE_COLUMNS)
      .single();
    if (error || !data) {
      if (error && isLastAdminError(error)) {
        return {
          ok: false,
          error: {
            status: 409,
            code: "LAST_ADMIN",
            message: "Nie można odebrać uprawnień ostatniemu aktywnemu administratorowi",
          },
        };
      }
      console.error("updateUser: zapis profilu", error?.code);
      return { ok: false, error: INTERNAL };
    }
    row = data as ProfileRow;
  }

  if (input.active === false) {
    const { error } = await admin.auth.admin.updateUserById(id, { ban_duration: BAN_DURATION });
    if (error) {
      // Profil jest już nieaktywny (dostęp zablokowany), ale logowanie w Auth nie zostało zablokowane.
      console.error("updateUser: ban", error.code);
      return {
        ok: false,
        error: {
          status: 500,
          code: "PARTIAL",
          message: "Konto dezaktywowane, ale nie udało się zablokować logowania. Ponów dezaktywację.",
        },
      };
    }
    const { error: revokeError } = await admin.rpc("revoke_user_sessions", { p_user_id: id });
    if (revokeError) {
      console.error("updateUser: revoke_user_sessions", revokeError.code);
      return {
        ok: false,
        error: {
          status: 500,
          code: "PARTIAL",
          message: "Konto dezaktywowane, ale nie udało się zakończyć jego sesji. Ponów dezaktywację.",
        },
      };
    }
  }

  return { ok: true, data: toDto(row) };
}
