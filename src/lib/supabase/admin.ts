import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getSupabasePublicEnv } from "./env";

/**
 * Klient z kluczem secret (omija RLS). TYLKO po stronie serwera, tylko po sprawdzeniu roli ADMIN.
 * `server-only` powoduje błąd budowania, gdyby moduł trafił do bundla klienta.
 */
export function createSupabaseAdminClient() {
  const { url } = getSupabasePublicEnv();
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!secret) {
    throw new Error("Brak SUPABASE_SECRET_KEY");
  }
  return createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
