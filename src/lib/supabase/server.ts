import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { getSupabasePublicEnv } from "./env";

/**
 * Klient Supabase działający w imieniu zalogowanego użytkownika (klucz publishable + sesja z cookies).
 * Podlega RLS. Używać w server components, server actions i route handlerach.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  const { url, key } = getSupabasePublicEnv();

  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Wywołane z server component (tam nie można ustawiać cookies) — sesję odświeża middleware.ts.
        }
      },
    },
  });
}
