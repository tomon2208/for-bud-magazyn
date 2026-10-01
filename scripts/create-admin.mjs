// Tworzy pierwsze konto ADMIN (login `admin`) w bazie z .env.local (klucze Supabase).
//   pnpm admin:create
// - Idempotentny: jeśli profil `admin` już istnieje, nic nie zmienia.
// - Hasło jest losowe i trafia WYŁĄCZNIE do .env.scripts (ADMIN_LOGIN / ADMIN_PASSWORD;
//   plik nieczytany przez Next/OpenNext, więc nie trafia do bundla Workera) — nigdy na konsolę.
// - Hasło zapisujemy do pliku PRZED utworzeniem konta, żeby nie dało się go zgubić.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const ENV_FILE = ".env.local";
const SCRIPTS_ENV_FILE = ".env.scripts";
const LOGIN = "admin";
const FULL_NAME = "Administrator";

if (!existsSync(ENV_FILE)) {
  console.error(`Brak pliku ${ENV_FILE}`);
  process.exit(1);
}
process.loadEnvFile(ENV_FILE);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) {
  console.error("Brak NEXT_PUBLIC_SUPABASE_URL lub SUPABASE_SECRET_KEY w .env.local");
  process.exit(1);
}

// Bez process.exit() po operacjach sieciowych — na Windows powoduje to awarię libuv przy zamykaniu połączeń.
async function main() {
  const supabase = createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: existing, error: existingError } = await supabase
    .from("profiles")
    .select("id, role, active")
    .eq("login", LOGIN)
    .maybeSingle();
  if (existingError) {
    console.error("Nie udało się sprawdzić istniejących kont:", existingError.code ?? existingError.message);
    process.exitCode = 1;
    return;
  }
  if (existing) {
    console.log(`Konto "${LOGIN}" już istnieje (rola ${existing.role}, aktywne: ${existing.active}) — bez zmian.`);
    return;
  }

  function upsertEnv(content, key, value) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, "m");
    if (re.test(content)) return content.replace(re, line);
    return `${content}${content.endsWith("\n") || content === "" ? "" : "\n"}${line}\n`;
  }

  // 32 znaki base64url (~192 bity entropii).
  const password = randomBytes(24).toString("base64url");

  let envContent = existsSync(SCRIPTS_ENV_FILE) ? readFileSync(SCRIPTS_ENV_FILE, "utf8") : "";
  envContent = upsertEnv(envContent, "ADMIN_LOGIN", LOGIN);
  envContent = upsertEnv(envContent, "ADMIN_PASSWORD", password);
  writeFileSync(SCRIPTS_ENV_FILE, envContent, "utf8");

  const { error } = await supabase.auth.admin.createUser({
    email: `${LOGIN}@forbud.local`,
    password,
    email_confirm: true,
    app_metadata: { login: LOGIN, full_name: FULL_NAME, role: "ADMIN" },
  });
  if (error) {
    console.error("Nie udało się utworzyć konta admin:", error.code ?? error.status ?? "błąd");
    process.exitCode = 1;
    return;
  }

  console.log(`Utworzono konto "${LOGIN}" (ADMIN). Hasło zapisano w ${SCRIPTS_ENV_FILE} (ADMIN_PASSWORD).`);
}

await main();
