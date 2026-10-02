# FOR-BUD MAGAZYN — plan działania

## Kontekst

Folder zawiera wyłącznie dokumentację (CLAUDE.md, FIRST_PROMPT.md, docs/, ADR 001–004, definicje agentów). Brak kodu, brak repozytorium git, **brak Node.js/npm/pnpm i Dockera** na komputerze (jest tylko git 2.55). Zgodnie z FIRST_PROMPT.md przygotowuję: architekturę, model tabel, API, strukturę folderów i kolejność etapów. Po akceptacji budujemy tylko fundament (Etap 0–1).

Decyzje podjęte z Tobą:
- jedna aplikacja Next.js wdrażana na Cloudflare Workers (OpenNext),
- rezerwacje na poziomie materiału (globalnie, bez lokalizacji),
- wydanie: zlecenie **albo** obowiązkowy powód,
- baza deweloperska: Supabase w chmurze (projekt `forbud-dev`), bez Dockera.

- repozytorium: https://github.com/tomon2208/for-bud-magazyn,
- **twarde ograniczenie: cały system mieści się w darmowych planach Cloudflare Workers i Supabase.**

---

## 0. Limity darmowych planów (wymaganie niefunkcjonalne)

Wartości do potwierdzenia w aktualnej dokumentacji w Etapie 0 (limity bywają zmieniane) i zapisania w `docs/decisions/005-free-tier.md`.

Cloudflare Workers Free:
- rozmiar skryptu Workera **≤ 3 MiB po kompresji** (paid: 10 MiB),
- czas startu Workera (parsowanie/wykonanie globalnego scope) ≤ ~1 s,
- **CPU ≈ 10 ms na żądanie**,
- 100 000 żądań/dzień, 50 subrequestów na żądanie,
- statyczne assety (JS/CSS/obrazki) serwowane bez liczenia do limitu żądań Workera.

Supabase Free:
- baza 500 MB, egress 5 GB/mies., 50 000 MAU (nas dotyczy kilkunastu użytkowników),
- **projekt usypiany po 7 dniach bez aktywności**,
- **brak kopii zapasowych do odtworzenia** na planie Free,
- 2 aktywne projekty (dev + prod).

Konsekwencje dla projektu:
1. **Bramka w Etapie 0 (decyzja go/no-go)**: po scaffoldzie Next.js + OpenNext mierzymy rozmiar Workera (`wrangler deploy --dry-run --outdir`, rozmiar gzip) i czas CPU stron SSR na żywym deployu. Ryzyko jest realne: OpenNext + Next.js często zbliża się do 3 MiB, a renderowanie SSR może przekraczać 10 ms CPU.
   - Jeśli mieści się z zapasem (≤ ~2,5 MiB, typowe żądanie < 10 ms CPU) → zostajemy przy jednej aplikacji.
   - Jeśli nie → plan B (ta sama struktura folderów UI i SQL, zmienia się tylko warstwa API): Next.js w trybie `output: 'export'` (statyczne assety, zero CPU Workera na UI) + mały Worker API (Hono, kilkadziesiąt KB) pod `/api/v1`. Logika stocku i tak siedzi w PostgreSQL, więc przejście jest tanie.
2. Worker jest „cienki”: walidacja + jedno wywołanie RPC. Zero ciężkich obliczeń w Workerze; agregacje (braki, dostępność) liczą widoki/funkcje SQL.
3. Strony mobilne terminala jako client components z danymi z API — minimalne SSR, małe bundle.
4. Kontrola rozmiaru w CI/skrypcie: `pnpm check:size` failuje, gdy Worker > 2,5 MiB gzip. Każda nowa biblioteka wymaga sprawdzenia wpływu na rozmiar (np. parser Excel w Etapie 12 → parsowanie po stronie przeglądarki, do Workera trafia już znormalizowany JSON).
5. Import plików LiczOkno parsowany w przeglądarce (CPU Workera i limit rozmiaru).
6. Kopie zapasowe: GitHub Actions (darmowe) — codzienny `pg_dump` bazy prod jako zaszyfrowany artefakt / do prywatnego miejsca; dodatkowo zapobiega usypianiu projektu. Bez backupu nie startujemy na produkcji.
7. Historia ruchów rośnie — szacunek: ~1 KB/ruch → 500 MB ≈ setki tysięcy ruchów; wystarczy na lata, monitorujemy rozmiar bazy na dashboardzie admina.

---

## A. Architektura

```
Telefon (PWA) / Desktop
   ↓ HTTPS
Next.js (App Router) na Cloudflare Workers  ← @opennextjs/cloudflare
   ├─ UI (server components + client components)
   └─ /api/v1/* route handlers  — walidacja (zod), sprawdzenie sesji, wywołanie RPC
   ↓ supabase-js z JWT użytkownika
Supabase PostgreSQL
   ├─ tabele z RLS (tylko SELECT wg roli; brak bezpośrednich INSERT/UPDATE na stock)
   └─ funkcje PL/pgSQL (SECURITY DEFINER) = jedyne miejsce zmiany stocku
Supabase Auth — logowanie e-mail/hasło, sesja w cookies (@supabase/ssr)
```

Granice odpowiedzialności:
- **Frontend** — tylko prezentacja i formularze; nigdy nie liczy stanu.
- **Route handlers (Worker)** — autentykacja, walidacja wejścia, mapowanie błędów na komunikaty, operacje admina (tworzenie użytkowników przez service role — klucz tylko po stronie serwera).
- **PostgreSQL** — źródło prawdy: transakcje, blokady, constrainty, autoryzacja ról w funkcjach (druga linia obrony obok RLS).

Dlaczego logika stocku w funkcjach DB: Workers nie trzymają długich połączeń/transakcji; jedno wywołanie RPC = jedna atomowa transakcja z blokadami. Nie da się tego obejść z klienta, bo rola `authenticated` nie ma uprawnień zapisu do tabel stockowych.

### Autoryzacja i role
- `profiles` (1:1 z `auth.users`): `role` enum `ADMIN | BIURO | PRODUKCJA`, `active`.
- Helper SQL `app.user_role()` czyta rolę z `profiles` dla `auth.uid()`; nieaktywny użytkownik = brak dostępu.
- RLS: SELECT dla ról wg docs/ROLES.md; zapis słowników (materiały, lokalizacje, dostawcy) przez polityki per rola; stock/ruchy/rezerwacje — zapis wyłącznie przez funkcje.
- Next.js middleware odświeża sesję i przekierowuje niezalogowanych; guard `requireRole()` w każdym route handlerze.
- Użytkowników tworzy ADMIN w aplikacji (brak publicznej rejestracji).

### Transakcyjne operacje stock (wzorzec każdej funkcji)
1. Sprawdź rolę i dane wejściowe (ilość > 0, aktywny materiał/lokalizacja, powód gdy wymagany).
2. **Idempotencja**: `client_request_id` (UUID generowany przez formularz) — unikalny w `stock_operations`; powtórzone kliknięcie/retry sieci zwraca istniejący wynik zamiast dublować ruch.
3. `SELECT … FROM materials WHERE id = $1 FOR UPDATE` — serializuje wszystkie operacje na danym materiale (wydania, rezerwacje, korekty) → brak race condition między dwoma użytkownikami.
4. Upsert/lock wiersza `stock(material_id, location_id)`; sprawdzenie dostępności.
5. INSERT nagłówka `stock_operations` + linii `stock_movements` (ze znakiem delta), UPDATE `stock`.
6. Constraint `CHECK (quantity >= 0)` na `stock` jako ostatnia bariera.
- `stock_movements` i `stock_operations`: trigger blokujący UPDATE/DELETE (ADR 002).
- Funkcja kontrolna `app.verify_stock()` — porównuje `stock` z sumą ruchów (test + przyszły monitoring).

Wydanie a rezerwacje: `wolne = Σ stock − Σ aktywnych pozostałych rezerwacji`. Wydanie dla zlecenia X dozwolone, gdy `ilość ≤ stan na lokalizacji` i `ilość ≤ wolne + pozostała rezerwacja X`; wydanie rozlicza rezerwację X (zwiększa `issued_quantity`, przy pełnym rozliczeniu status `FULFILLED`).

---

## B. Model tabel (PostgreSQL)

Ilości: `numeric(12,3)` (obsługa mb). Wszystkie ID: `uuid`. Znaczniki czasu `timestamptz`.

| Tabela | Kluczowe kolumny |
|---|---|
| `profiles` | id (=auth.users.id), full_name, role, active, created_at |
| `material_categories` | id, name unique, active |
| `suppliers` | id, name, contact_info, active |
| `materials` | id, code unique, name, category_id, unit (text, np. szt./sztanga/mb/opak.), default_supplier_id null, active, notes, created_at/by |
| `locations` | id, code unique (np. A-03-02, to samo co w QR), name, description, active |
| `stock` | PK(material_id, location_id), quantity ≥ 0, updated_at |
| `stock_operations` | id, type (`RECEIPT/ISSUE/TRANSFER/ADJUSTMENT/INVENTORY`), user_id, created_at, production_order_id null, supplier_id null (przy przyjęciu — może różnić się od domyślnego), reason null, reference text null, client_request_id unique |
| `stock_movements` | id, operation_id, material_id, location_id, quantity_delta (≠0, ze znakiem), created_at, user_id — niemutowalne |
| `production_orders` | id, name (nieunikalna), client_name, status (`OPEN/IN_PROGRESS/DONE/CANCELLED`), notes, created_at/by |
| `requirements` | id, production_order_id, source (`MANUAL/IMPORT`), imported_file_name, import_format, created_at/by |
| `requirement_items` | id, requirement_id, material_id, quantity, unit, raw_source_ref (oryginalny kod/wiersz z pliku — tylko referencja) |
| `reservations` | id, production_order_id, material_id, quantity, issued_quantity, status (`ACTIVE/RELEASED/FULFILLED`), created_at/by, released_at/by |

Przesunięcie = 1 operacja `TRANSFER` + 2 ruchy (−A, +B). Korekta = operacja `ADJUSTMENT` z obowiązkowym `reason`, tylko ADMIN.

Później (nie teraz): `import_material_mappings` (kod LiczOkno → material_id, per format), `inventory_sessions/inventory_counts`, `purchase_orders`.

Widoki: `v_material_availability` (stan łączny, zarezerwowane, wolne), `v_order_shortages` (potrzebne, dostępne, zarezerwowane dla zlecenia, brakujące).

---

## C. Główne API (`/api/v1`)

| Metoda / ścieżka | Rola | Opis |
|---|---|---|
| GET/POST/PATCH `/materials`, `/categories`, `/suppliers` | odczyt: wszyscy; zapis: ADMIN (+BIURO dostawcy) | kartoteki |
| GET/POST/PATCH `/locations` | odczyt: wszyscy; zapis: ADMIN | lokalizacje |
| GET `/locations/by-code/:code` | wszyscy | rozpoznanie skanu → lokalizacja + jej zawartość |
| GET `/stock?material=&location=` | wszyscy | stany |
| POST `/stock/receipts` | PRODUKCJA, ADMIN | → `rpc stock_receipt` |
| POST `/stock/issues` | PRODUKCJA, ADMIN | → `rpc stock_issue` |
| POST `/stock/transfers` | PRODUKCJA, ADMIN | → `rpc stock_transfer` |
| POST `/stock/adjustments` | ADMIN | → `rpc stock_adjust` |
| GET `/movements?…` | wszyscy (filtry, paginacja) | historia |
| GET/POST/PATCH `/orders` | BIURO, ADMIN (PRODUKCJA odczyt) | zlecenia |
| GET/POST `/orders/:id/requirements` | BIURO, ADMIN | zapotrzebowanie (ręczne; import później) |
| GET `/orders/:id/shortages` | BIURO, ADMIN | analiza braków |
| POST `/reservations`, POST `/reservations/:id/release` | BIURO, ADMIN | → `rpc reserve` / `rpc release_reservation` |
| GET/POST/PATCH `/admin/users` | ADMIN | użytkownicy i role |

Wszystkie POST zmieniające stock przyjmują `client_request_id`.

---

## D. Struktura repozytorium

```
forbud-magazyn/
├─ CLAUDE.md, README.md, docs/ (bez zmian + nowe ADR: 005-opennext, 006-stock-functions)
├─ .claude/agents/
├─ src/
│  ├─ app/
│  │  ├─ (auth)/login/
│  │  ├─ (desktop)/            dashboard, magazyn, materialy, lokalizacje, zlecenia,
│  │  │                        zapotrzebowania, braki, przyjecia, wydania, historia, admin
│  │  ├─ m/                    terminal mobilny: SKANUJ, PRZYJĘCIE, WYDANIE, SZUKAJ, LOKALIZACJE
│  │  └─ api/v1/…              route handlers
│  ├─ components/ui/           shadcn/ui
│  ├─ components/              komponenty współdzielone
│  ├─ server/                  auth guard, wywołania RPC, mapowanie błędów DB
│  ├─ lib/supabase/            klienci server/browser/admin
│  ├─ lib/validation/          schematy zod (wspólne dla UI i API)
│  └─ modules/liczokno-import/ (Etap 11) parsery wymienne → znormalizowany format
├─ supabase/
│  ├─ migrations/              numerowane SQL (schema, RLS, funkcje stock)
│  └─ seed.sql                 dane testowe (kategorie, kilka materiałów, lokalizacje)
├─ tests/
│  ├─ unit/                    vitest
│  └─ db/                      vitest integracyjne na forbud-dev (role, RLS, współbieżność)
├─ wrangler.jsonc, open-next.config.ts, next.config.ts
└─ package.json (pnpm)
```

Biblioteki (każda uzasadniona): next, react, typescript, tailwindcss, shadcn/ui (+ jego zależności radix), @supabase/supabase-js, @supabase/ssr, zod (walidacja wejścia), @opennextjs/cloudflare + wrangler (deploy na Workers), vitest. Skaner i generowanie QR — decyzja w Etapie 3/4 (najpierw natywne `BarcodeDetector`, fallback lekka biblioteka tylko jeśli potrzebna na iOS).

---

## E. Kolejność implementacji

Każdy etap: Implementer → testy/lint/typecheck/build → Reviewer → poprawki CRITICAL/HIGH → Twoja akceptacja.

**Etap 0 — środowisko i szkielet** (start po akceptacji)
- Ty: instalacja Node 24 LTS + `corepack enable` (pnpm), założenie projektu Supabase `forbud-dev`, konto Cloudflare; klucze do `.env.local` (poza gitem).
- `git init` + remote `https://github.com/tomon2208/for-bud-magazyn`, `.gitignore` (m.in. `.env*`), scaffold Next.js + TS + Tailwind + shadcn/ui, ESLint, vitest, OpenNext/wrangler, Supabase CLI (przez `pnpm dlx`), skrypty `dev/build/test/typecheck/lint/db:push`.
- Weryfikacja: `pnpm build`, `pnpm preview` (lokalny Worker), pusty test przechodzi.
- **Bramka free tier** (sekcja 0): pomiar rozmiaru Workera i CPU na testowym deployu → decyzja: jedna aplikacja vs plan B; zapis w ADR 005.
- GitHub Actions: lint/typecheck/test/build + `check:size` na każdym pushu.

**Etap 1 — auth i role**: migracja `profiles` + enum ról + `app.user_role()`, logowanie, middleware, layout desktop i osobny layout mobilny `/m`, panel ADMIN użytkowników, testy dostępu per rola.

**Etap 2 — kartoteki**: kategorie, dostawcy, materiały (CRUD, wyszukiwanie, aktywny/nieaktywny), RLS.

**Etap 3 — lokalizacje i kody**: CRUD lokalizacji, `by-code`, strona wydruku etykiet QR (prosta), ekran SKANUJ (kamera + ręczne wpisanie kodu).

**Etap 4 — rdzeń stocku + przyjęcia**: `stock`, `stock_operations`, `stock_movements`, triggery niemutowalności, `stock_receipt`, idempotencja; mobilny flow skan → materiał → ilość → zatwierdź; test równoległych przyjęć.
- **Baza:** decyzja użytkownika (2026-10-01) — jeden projekt Supabase przez cały okres budowy (limit 2 projektów w planie Free, drugi slot zajęty). Dane w bazie do startu traktujemy jako testowe.
- **Blokady kartoteki (z review Etapu 2):** zakaz zmiany `unit` materiału, gdy istnieją ruchy (`UNIT_LOCKED`); zakaz dezaktywacji materiału ze stanem ≠ 0 (`HAS_STOCK`, w Etapie 11 także z aktywnymi rezerwacjami); ruchy zawsze po `material_id`, nigdy po kodzie; zmiana kodu po imporcie LiczOkno — do decyzji w Etapie 12.
- **Blokada lokalizacji (z review Etapu 3):** dezaktywacja lokalizacji tylko gdy suma stanu w niej = 0 (`LOCATION_NOT_EMPTY`).

**Etap 5 — wydania i przesunięcia**: `stock_issue` (zlecenie lub powód), `stock_transfer`; test: dwa równoczesne wydania nie zejdą poniżej zera.
- Zrealizowano (ADR 010): `stock_issue` (zlecenie ALBO powód z listy SERWIS/USZKODZENIE/ZUZYCIE_WLASNE/PROBKA/INNY), `stock_transfer`, proste zlecenia (`production_orders`: nazwa, notatka, status), terminal WYDANIE/PRZESUNIĘCIE, desktop „Zlecenia” i „Wydania”. Rozstrzygnięta otwarta kwestia powodów: stała lista kodów.

**Etap 6 — korekty i historia ruchów**: `stock_adjust` (ADMIN, powód), widok historii z filtrami, `verify_stock()`.
- Decyzje użytkownika (2026-10-02): korekta = „ustaw stan na X” (system liczy różnicę i zapisuje ruch ADJUSTMENT z powodem); ADMIN ma „Cofnij ten ruch” w historii — storno (ruch odwrotny powiązany z oryginałem, z powodem; oryginał oznaczony jako cofnięty; nie da się cofnąć dwa razy ani zejść poniżej zera).
- Zrealizowano (ADR 011): `stock_adjust` (expected_current → `STOCK_CHANGED`, różnica 0 → `NO_CHANGE`, nieaktywne tylko w dół), `stock_reverse` (typ `REVERSAL`, `reverses_operation_id` UNIQUE, zlecenie kopiowane), historia `/historia` z filtrami w SQL, korekta desktop (`/magazyn/korekta`) i terminal (`/m/korekta`), kontrola spójności dla ADMIN-a.

- Odbiór użytkownika (2026-10-02): Etapy 5–6 przetestowane na produkcji (wydania, przesunięcia, zlecenia, korekty, cofanie, historia) — „wszystko działa”.

**Etap 7 — dashboard i stany**: stan per materiał/lokalizacja, zawartość lokalizacji, wyszukiwanie mobilne.
- Decyzje użytkownika (2026-10-02): opcjonalny „stan minimalny” w kartotece materiału (puste = brak alarmu), dashboard z listą materiałów poniżej minimum; eksport stanów do CSV (Excel, polskie znaki, przecinek dziesiętny, bez nowych bibliotek).

**Etap 8 — zlecenia**: CRUD, statusy, wybór zlecenia przy wydaniu.

**Etap 9–10 — zapotrzebowanie i braki**: ręczne pozycje zapotrzebowania, widok potrzebne/dostępne/zarezerwowane/brakujące.

**Etap 11 — rezerwacje**: `reserve`, `release_reservation`, rozliczanie przy wydaniu, testy race conditions.

**Etap 12 — import LiczOkno**: dopiero po dostarczeniu przykładowych plików; interfejs parsera + mapowanie kodów materiałów.

**Etap 13 — inwentaryzacja**: sesja inwentaryzacyjna, różnice → ruchy `INVENTORY`.

Poza MVP: automatyczne zamówienia, PDF/PZ/WZ, resztki profili, integracja online z LiczOkno.

---

## Weryfikacja (dla każdego etapu)

- `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
- Testy DB na `forbud-dev` z trzema użytkownikami testowymi (ADMIN/BIURO/PRODUKCJA): próby niedozwolonych operacji przez API i bezpośrednio przez supabase-js muszą zwracać błąd; równoległe wydania (`Promise.all`) nie dają stanu < 0; powtórzony `client_request_id` nie dubluje ruchu; `verify_stock()` zwraca 0 rozbieżności.
- Ręcznie: `pnpm preview` (lokalny Worker) w przeglądarce w trybie desktop i mobile (375 px) — realny przepływ przyjęcia/wydania.
- `pnpm check:size` — Worker ≤ 2,5 MiB gzip; po deployu sprawdzenie CPU time w Cloudflare dashboard (< 10 ms dla typowych żądań).
- Reviewer (agent) bez uwag CRITICAL przed zamknięciem etapu.

## Start produkcyjny (checklista — przed wprowadzeniem prawdziwych danych)
1. Wyzerowanie bazy: wszystkie tabele i konta testowe usunięte, migracje od zera (`supabase db reset --db-url …` lub nowy projekt), nowy ADMIN (`pnpm admin:create`), nowe silne hasło do bazy.
2. Backup: codzienny `pg_dump` przez GitHub Actions (plan Free nie ma kopii) — uruchomiony i sprawdzone odtworzenie.
3. **Testy po starcie:** `pnpm test:db` NIE może już działać na bazie produkcyjnej. Przed startem zdecydować: lokalny Supabase (Docker) do testów DB, albo zwolnienie drugiego projektu Supabase na bazę testową.
4. Rotacja kluczy Supabase (secret) i aktualizacja sekretu w Cloudflare.
5. Usunięcie funkcji `purge_test_stock` (sprzątanie testów, ADR 009) migracją — na produkcji ruchów nie wolno usuwać żadną ścieżką.

## Otwarte kwestie na później (nie blokują Etapu 0–3)
- Czy PRODUKCJA może wydawać bez zlecenia każdy powód, czy z listy zamkniętej (powody jako słownik?) — rozstrzygniemy w Etapie 5.
- ~~Logowanie pracowników~~ — ROZSTRZYGNIĘTE: login + hasło nadawane przez ADMIN; pod spodem techniczny e-mail `<login>@forbud.local` w Supabase Auth.
- Formaty plików LiczOkno — po dostarczeniu przykładów.
