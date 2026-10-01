// Blokada `pnpm deploy` z maszyny deweloperskiej.
// OpenNext wkleja zawartość plików .env* do bundla Workera (.open-next/cloudflare/next-env.mjs),
// więc deploy wolno robić tylko z czystego środowiska (CI): NEXT_PUBLIC_* jako zmienne buildu,
// SUPABASE_SECRET_KEY jako `wrangler secret`. Procedura: docs/decisions/006-auth-roles.md.
import { existsSync, readFileSync } from "node:fs";

const problems = [];
if (existsSync(".env.local")) problems.push(".env.local istnieje");
for (const file of [".env", ".env.production", ".env.production.local"]) {
  if (!existsSync(file)) continue;
  const keys = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.match(/^([A-Za-z0-9_]+)=/)?.[1])
    .filter(Boolean);
  const nonPublic = keys.filter((k) => !k.startsWith("NEXT_PUBLIC_"));
  if (nonPublic.length > 0) problems.push(`${file} zawiera zmienne inne niż NEXT_PUBLIC_*: ${nonPublic.join(", ")}`);
}

if (problems.length > 0) {
  console.error("Deploy przerwany — środowisko nie jest czyste:");
  for (const p of problems) console.error(`  - ${p}`);
  console.error("Deploy tylko z CI / czystego katalogu. Szczegóły: docs/decisions/006-auth-roles.md");
  process.exit(1);
}
console.log("deploy-guard OK");
