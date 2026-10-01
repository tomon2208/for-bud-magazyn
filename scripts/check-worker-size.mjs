// Bramka darmowego planu Cloudflare Workers (docs/PLAN.md, sekcja 0).
// Wymaga wcześniejszego `pnpm cf:build`. Wrangler w trybie dry-run bundluje Workera
// i raportuje rozmiar po kompresji gzip — to ta wartość podlega limitowi 3 MiB.
import { execSync } from "node:child_process";

const LIMIT_KIB = 2.5 * 1024; // zapas względem limitu 3 MiB

const out = execSync("pnpm wrangler deploy --dry-run --outdir .wrangler/size-check", {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

const match = out.match(/gzip:\s*([\d.]+)\s*KiB/);
if (!match) {
  console.error(out);
  console.error("Nie udało się odczytać rozmiaru gzip z wyjścia wranglera.");
  process.exit(2);
}

const gzipKiB = Number(match[1]);
const pct = ((gzipKiB / LIMIT_KIB) * 100).toFixed(0);
console.log(`Worker gzip: ${gzipKiB.toFixed(1)} KiB / limit ${LIMIT_KIB} KiB (${pct}%)`);

if (gzipKiB > LIMIT_KIB) {
  console.error("Przekroczony budżet rozmiaru Workera dla darmowego planu.");
  process.exit(1);
}
