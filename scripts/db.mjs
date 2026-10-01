// Uruchamia Supabase CLI na bazie z SUPABASE_DB_URL (.env.scripts), np.:
//   pnpm db:push            → wgrywa migracje z supabase/migrations
//   pnpm db:migrations      → lista migracji lokalnie vs w bazie
// Bez powłoki (shell): URL z hasłem trafia wyłącznie jako argument procesu CLI,
// nie jest interpretowany przez cmd.exe/sh. CLI nie przyjmuje --db-url ze zmiennej środowiskowej.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const ENV_FILE = ".env.scripts";
if (!existsSync(ENV_FILE)) {
  console.error(`Brak pliku ${ENV_FILE} (wzór: .env.scripts.example)`);
  process.exit(1);
}
process.loadEnvFile(ENV_FILE);
const dbUrl = process.env.SUPABASE_DB_URL?.trim();
if (!dbUrl) {
  console.error(`Brak SUPABASE_DB_URL w ${ENV_FILE}`);
  process.exit(1);
}

const require = createRequire(import.meta.url);
const cli = require.resolve("supabase/dist/supabase.js");
const args = [cli, ...process.argv.slice(2), "--db-url", dbUrl];
const result = spawnSync(process.execPath, args, { stdio: "inherit" });
process.exitCode = result.status ?? 1;
