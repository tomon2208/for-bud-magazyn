// Kontrola wycieku sekretów do artefaktów OpenNext (uruchamiać po `pnpm cf:build`, także w CI).
// - w całym .open-next/ nie może być nazw SUPABASE_DB_URL ani ADMIN_PASSWORD (zmienne skryptów),
// - w .open-next/assets (pliki publiczne) nie może być SUPABASE_SECRET_KEY ani klucza sb_secret_…,
// - jeśli lokalnie są pliki env, sprawdzamy też same WARTOŚCI (bez ich wypisywania).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = ".open-next";
const ASSETS = path.join(ROOT, "assets");

if (!existsSync(ROOT)) {
  console.error("Brak katalogu .open-next — uruchom najpierw `pnpm cf:build`.");
  process.exit(2);
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (st.size < 50 * 1024 * 1024) yield full;
  }
}

function readEnvValues(file, keys) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && keys.includes(m[1])) {
      const v = m[2].trim().replace(/^["']|["']$/g, "");
      if (v.length >= 8) out.push({ name: m[1], value: v });
    }
  }
  return out;
}

// Reguły: [nazwa reguły, katalog, test(content)]
const rules = [
  ["nazwa SUPABASE_DB_URL", ROOT, (c) => c.includes("SUPABASE_DB_URL")],
  ["nazwa ADMIN_PASSWORD", ROOT, (c) => c.includes("ADMIN_PASSWORD")],
  ["nazwa SUPABASE_SECRET_KEY w assets", ASSETS, (c) => c.includes("SUPABASE_SECRET_KEY")],
  ["klucz sb_secret_… w assets", ASSETS, (c) => /sb_secret_[A-Za-z0-9_-]{16,}/.test(c)],
];
for (const { name, value } of readEnvValues(".env.scripts", ["SUPABASE_DB_URL", "ADMIN_PASSWORD"])) {
  rules.push([`wartość ${name}`, ROOT, (c) => c.includes(value)]);
}
for (const { name, value } of readEnvValues(".env.local", ["SUPABASE_SECRET_KEY"])) {
  rules.push([`wartość ${name} w assets`, ASSETS, (c) => c.includes(value)]);
}

let failed = 0;
const files = [...walk(ROOT)];
for (const file of files) {
  let content;
  try {
    content = readFileSync(file, "latin1");
  } catch {
    continue;
  }
  for (const [ruleName, dir, test] of rules) {
    if (!file.startsWith(dir + path.sep) && file !== dir) continue;
    if (test(content)) {
      console.error(`WYCIEK: ${ruleName} w ${file}`);
      failed++;
    }
  }
}

if (failed > 0) {
  console.error(`Znaleziono ${failed} potencjalnych wycieków sekretów w artefaktach buildu.`);
  process.exit(1);
}
console.log(`check:secrets OK (${files.length} plików, ${rules.length} reguł)`);
