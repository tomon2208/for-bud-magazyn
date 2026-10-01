# FOR-BUD MAGAZYN

System magazynowy FOR-BUD. Plan: [docs/PLAN.md](docs/PLAN.md). Zasady projektu: [CLAUDE.md](CLAUDE.md).

## Wymagania

- Node.js 24 LTS, pnpm (`corepack enable`)

## Komendy

| Komenda | Opis |
|---|---|
| `pnpm dev` | serwer deweloperski Next.js |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | jakość kodu |
| `pnpm cf:build` | build Workera (OpenNext) |
| `pnpm check:size` | budżet rozmiaru Workera — darmowy plan (po `cf:build`) |
| `pnpm preview` | build + lokalny Worker (wrangler) |
| `pnpm deploy` | deploy na Cloudflare |

Konfiguracja: skopiuj `.env.example` do `.env.local` i uzupełnij klucze Supabase.
