# FOR-BUD MAGAZYN

System magazynowy FOR-BUD. Plan: [docs/PLAN.md](docs/PLAN.md). Zasady projektu: [CLAUDE.md](CLAUDE.md).

## Wymagania

- Node.js 24 LTS, pnpm (`corepack enable`)

## Komendy

| Komenda | Opis |
|---|---|
| `pnpm dev` | serwer deweloperski Next.js |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | jakość kodu (testy jednostkowe, bez sieci) |
| `pnpm test:db` | testy integracyjne na bazie dev (wymaga `.env.local`) |
| `pnpm db:push` / `pnpm db:migrations` | wgranie / lista migracji w bazie z `SUPABASE_DB_URL` |
| `pnpm admin:create` | pierwsze konto ADMIN (`admin`), hasło zapisywane w `.env.local` |
| `pnpm cf:build` | build Workera (OpenNext) |
| `pnpm check:size` | budżet rozmiaru Workera — darmowy plan (po `cf:build`) |
| `pnpm check:secrets` | brak sekretów w artefaktach buildu (po `cf:build`) |
| `pnpm preview` | build + lokalny Worker (wrangler) |
| `pnpm deploy` | deploy na Cloudflare — tylko z CI / czystego katalogu (blokada przy `.env.local`) |

Konfiguracja: skopiuj `.env.example` do `.env.local` (klucze Supabase dla aplikacji) oraz `.env.scripts.example` do `.env.scripts` (hasło do bazy i konto admina — tylko dla skryptów; ten plik nie trafia do bundla Workera).

Deploy na produkcję: procedura w [ADR 006](docs/decisions/006-auth-roles.md#sekrety-i-deploy).

### Cloudflare — gdzie ustawić zmienne

- `SUPABASE_SECRET_KEY` ustaw w Cloudflare: **Worker → Settings → Variables and Secrets** jako typ **Secret** (runtime Workera). **Nie** w sekcji *Build* — tam trafiają tylko `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` i `NODE_VERSION`.
- Klucz secret jest używany tylko przez panel użytkowników (`/api/v1/admin/users`); kartoteki (materiały, dostawcy, kategorie) działają na kluczu publishable + sesji użytkownika (RLS).
