import { existsSync } from "node:fs";

// .env.local — klucze Supabase (jak aplikacja); .env.scripts — SUPABASE_DB_URL dla testów SQL.
if (!existsSync(".env.local")) {
  throw new Error("Testy DB wymagają pliku .env.local z kluczami bazy dev");
}
process.loadEnvFile(".env.local");
if (existsSync(".env.scripts")) process.loadEnvFile(".env.scripts");
