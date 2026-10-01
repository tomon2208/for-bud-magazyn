# ADR 006 — Uwierzytelnianie i role

## Decyzja

- Logowanie **login + hasło**. Login `^[a-z0-9._-]{3,32}$` (zapisywany lowercase). W Supabase Auth konto ma techniczny e-mail `<login>@forbud.local`. Brak publicznej rejestracji — konta zakłada ADMIN.
- Hasło: **min. 8 znaków** (maks. 72 bajty — limit bcrypt), decyzja użytkownika: pracownicy produkcji nie zapamiętają długich haseł. Ochronę przed zgadywaniem zapewniają limity prób logowania Supabase Auth (logowanie idzie z urządzenia bezpośrednio do Auth). Minimalną długość hasła w ustawieniach projektu Supabase (Auth → Providers → Email) ustawia użytkownik na 8 — zmiana poza migracjami. Hasło konta `admin` z `pnpm admin:create` pozostaje losowe i długie.
- **Źródło prawdy o roli i aktywności: `public.profiles`** (nie claim w JWT). Każde żądanie serwera czyta profil, więc dezaktywacja działa natychmiast, mimo że wydany JWT jest ważny do wygaśnięcia.
- `app.user_role()` (prywatny schemat `app`, niewystawiony w Data API) zwraca rolę aktywnego użytkownika albo NULL — podstawa przyszłych polityk RLS. (Pierwotnie `app.current_role()` — zmienione migracją `20261001120000`, bo `current_role` to słowo kluczowe SQL.)
- Profil tworzy odroczony trigger (`DEFERRABLE INITIALLY DEFERRED`) na `auth.users` z `raw_app_meta_data` (login, full_name, role). Niepoprawne metadane → wyjątek → konto nie powstaje. `app_metadata` może ustawić tylko klucz secret. Po utworzeniu rolę zmienia się wyłącznie w `profiles` (app_metadata nie jest synchronizowane i nie jest używane do autoryzacji).
- `profiles`: authenticated ma tylko SELECT (własny wiersz; ADMIN wszystkie). Zapis wyłącznie przez serwer kluczem secret po sprawdzeniu roli ADMIN (`/api/v1/admin/users`).
- Ochrona ostatniego aktywnego ADMIN-a w bazie: trigger BEFORE UPDATE/DELETE z `pg_advisory_xact_lock` (serializuje równoległe degradacje). Poprawność zakłada READ COMMITTED (domyślny w PostgREST) — w REPEATABLE READ odebranie uprawnień ADMIN jest odrzucane (`hint = ISOLATION`). Dodatkowo API nie pozwala adminowi zdezaktywować ani zdegradować samego siebie.
- Dezaktywacja: `profiles.active = false` (natychmiast) + ban w Auth (`ban_duration`) + `public.revoke_user_sessions(uuid)` (usuwa sesje i refresh tokeny; EXECUTE tylko `service_role`) — bez tego po ponownej aktywacji stary refresh token znów by działał. Aktywacja: zdjęcie bana, potem `active = true`. Zmiana hasła wykonywana jako pierwsza. Kolejność bezpieczna przy częściowej awarii.
- Logowanie wykonuje przeglądarka bezpośrednio w Supabase Auth (`@supabase/ssr`, sesja w cookies). Dzięki temu limity prób logowania Supabase liczone są per urządzenie, a nie per wspólny adres IP Workera, i logowanie nie zużywa CPU Workera. Po zalogowaniu formularz sprawdza profil; konto nieaktywne → wylogowanie i komunikat. Serwer i tak weryfikuje rolę/aktywność przy każdym żądaniu.
- Autoryzacja zawsze po stronie serwera: `requirePageRole()` w layoutach/stronach (redirect), `requireApiRole()` w route handlerach (401/403 JSON).
- **CSRF (wzorzec dla wszystkich endpointów mutujących, także stockowych):** POST/PUT/PATCH/DELETE w `/api` wymagają `Content-Type: application/json` (inaczej 415) i `Origin` zgodnego z hostem żądania; bez `Origin` tylko `Sec-Fetch-Site: same-origin`, inaczej 403 (`src/lib/csrf.ts`). Sprawdzane w middleware oraz ponownie w handlerze (`parseJsonBody` / `guardMutation`). Cookies sesji Supabase mają SameSite=Lax.
- Nagłówki bezpieczeństwa (`next.config.ts`): `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors none`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`.

## Ostrzeżenia

- **Rola w `app_metadata` (i w claimach JWT) jest nieaktualna po zmianie roli.** Nie używać `auth.jwt() -> app_metadata` w politykach RLS ani w kodzie — wyłącznie `app.user_role()` / `profiles`.
- **Konta tworzone z panelu Supabase (Add user / Invite) są odrzucane przez trigger** — nie mają `app_metadata.login/role` ani e-maila `<login>@forbud.local`. Użytkowników zakłada się tylko w aplikacji (`/admin/uzytkownicy`) lub `pnpm admin:create`.

## Middleware zamiast `proxy.ts`

Next.js 16 zmienił nazwę `middleware` na `proxy`, ale `proxy.ts` działa **wyłącznie w runtime Node.js**. `@opennextjs/cloudflare` 1.20 obsługuje go eksperymentalnie („not officially maintained”) i zwiększa Workera o ~400 KiB gzip (pomiar: 1782 vs 1391 KiB). Używamy więc `src/middleware.ts` (Edge runtime, w pełni wspierany przez OpenNext). Next 16 wyświetla ostrzeżenie o przestarzałej konwencji — do ponownej oceny przy aktualizacji Next/OpenNext.
Middleware jest tylko optymistyczną bramką (odświeżenie sesji, redirect na /login, 401 dla /api) — nie decyduje o uprawnieniach.

## Build: webpack zamiast Turbopack

`next build --webpack`: Turbopack duplikował supabase-js i zod w osobnych chunkach per trasa, a OpenNext bundluje je wszystkie do Workera — 2077 KiB gzip vs **1391 KiB** z webpackiem (budżet 2560 KiB). `pnpm dev` nadal używa Turbopacka.

## Konsekwencje

- Każde żądanie strony/API = odczyt JWT (`getClaims`) + 1 zapytanie o profil.
- Testy integracyjne (`pnpm test:db`) działają na bazie dev i nie są uruchamiane w CI. Testy ochrony ostatniego ADMIN-a działają w transakcjach SQL kończonych ROLLBACK (devDependency `postgres`, nie trafia do Workera).

## Sekrety i deploy

OpenNext wkleja przy budowie **całą zawartość plików `.env*`** (w tym `.env.local`) do `.open-next/cloudflare/next-env.mjs`, czyli do kodu Workera. Dlatego:
- `.env.local` zawiera tylko zmienne aplikacji (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` — do lokalnego `wrangler dev`),
- zmienne skryptów (`SUPABASE_DB_URL` z hasłem do bazy, `ADMIN_LOGIN`, `ADMIN_PASSWORD`) są w `.env.scripts` — Next/OpenNext go nie czyta,
- `pnpm check:secrets` (także w CI po `cf:build`) failuje, gdy w `.open-next/` są nazwy/wartości `SUPABASE_DB_URL` lub `ADMIN_PASSWORD`, a w `.open-next/assets` `SUPABASE_SECRET_KEY` lub klucz `sb_secret_…`.

Procedura deployu (produkcja):
1. Deploy tylko z czystego środowiska (CI). `pnpm deploy` uruchamia `scripts/deploy-guard.mjs`, który przerywa, jeśli istnieje `.env.local` albo `.env` / `.env.production(.local)` zawiera zmienne inne niż `NEXT_PUBLIC_*`.
2. `NEXT_PUBLIC_SUPABASE_URL` i `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — zmienne środowiskowe buildu (np. sekrety/zmienne CI, ewentualnie `.env.production` z samymi `NEXT_PUBLIC_*`).
3. `SUPABASE_SECRET_KEY` — jednorazowo `pnpm wrangler secret put SUPABASE_SECRET_KEY` (dostępny w runtime jako `process.env` dzięki `nodejs_compat`), nigdy w plikach buildu.
4. `pnpm deploy` = guard → `opennextjs-cloudflare build` → `check:secrets` → `opennextjs-cloudflare deploy`.
