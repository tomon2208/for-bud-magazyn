import type { AppRole } from "@/lib/validation/auth";

export type AuthDecision = "ok" | "unauthenticated" | "forbidden";

/** Czysta decyzja autoryzacyjna — bez zależności od Next/Supabase (testowalna). */
export function authorize(
  user: { role: AppRole } | null,
  allowed: readonly AppRole[],
): AuthDecision {
  if (!user) return "unauthenticated";
  if (allowed.length > 0 && !allowed.includes(user.role)) return "forbidden";
  return "ok";
}

/** Strona startowa po zalogowaniu: PRODUKCJA → terminal mobilny, pozostali → dashboard. */
export function homePathForRole(role: AppRole): string {
  return role === "PRODUKCJA" ? "/m" : "/dashboard";
}
