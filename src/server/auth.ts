import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import type { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { AppRole } from "@/lib/validation/auth";
import { authorize, homePathForRole } from "@/lib/authorize";
import { jsonError } from "./http";

export type CurrentUser = {
  id: string;
  login: string;
  fullName: string;
  role: AppRole;
};

export type AuthState =
  | { status: "anonymous" }
  | { status: "inactive" }
  | { status: "active"; user: CurrentUser };

/**
 * Stan uwierzytelnienia bieżącego żądania. Rola i aktywność ZAWSZE z tabeli profiles
 * (nie z JWT) — dezaktywacja konta działa od następnego żądania.
 * Wynik jest zapamiętywany w obrębie jednego żądania (React cache).
 */
export const getAuthState = cache(async (): Promise<AuthState> => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  if (error || !userId) return { status: "anonymous" };

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, login, full_name, role, active")
    .eq("id", userId)
    .maybeSingle();

  if (profileError) {
    console.error("getAuthState: błąd odczytu profilu", profileError.code);
    return { status: "anonymous" };
  }
  if (!profile || !profile.active) return { status: "inactive" };

  return {
    status: "active",
    user: {
      id: profile.id as string,
      login: profile.login as string,
      fullName: profile.full_name as string,
      role: profile.role as AppRole,
    },
  };
});

/** Zalogowany i aktywny użytkownik albo null. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const state = await getAuthState();
  return state.status === "active" ? state.user : null;
}

/**
 * Guard dla route handlerów: 401 (brak sesji / konto nieaktywne) albo 403 (zła rola) jako JSON.
 * Pusta lista ról = dowolny zalogowany, aktywny użytkownik.
 */
export async function requireApiRole(
  ...roles: AppRole[]
): Promise<{ ok: true; user: CurrentUser } | { ok: false; response: NextResponse }> {
  const user = await getCurrentUser();
  const decision = authorize(user, roles);
  if (decision === "unauthenticated" || !user) {
    return { ok: false, response: jsonError(401, "UNAUTHENTICATED", "Wymagane zalogowanie") };
  }
  if (decision === "forbidden") {
    return { ok: false, response: jsonError(403, "FORBIDDEN", "Brak uprawnień") };
  }
  return { ok: true, user };
}

/**
 * Guard dla stron (server components): brak sesji → /login, konto nieaktywne → /login z komunikatem,
 * zła rola → strona startowa właściwa dla roli użytkownika.
 */
export async function requirePageRole(...roles: AppRole[]): Promise<CurrentUser> {
  const state = await getAuthState();
  if (state.status === "anonymous") redirect("/login");
  if (state.status === "inactive") redirect("/login?konto=nieaktywne");
  const { user } = state;
  if (authorize(user, roles) === "forbidden") redirect(homePathForRole(user.role));
  return user;
}
