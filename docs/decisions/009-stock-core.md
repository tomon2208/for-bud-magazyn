# ADR 009 — Rdzeń stocku i przyjęcia (Etap 4)

Migracja: `supabase/migrations/20261001200000_stock_core.sql`. Rozwija ADR 002 (ledger) i PLAN sekcja A/B.

## Model

| Tabela | Rola |
|---|---|
| `stock_operations` | nagłówek operacji: `type` (`RECEIPT/ISSUE/TRANSFER/ADJUSTMENT/INVENTORY`), `user_id`, `created_at`, `client_request_id` **unique**, `production_order_id` (bez FK — dodamy w Etapie 8), `supplier_id`, `document_ref` (≤ 100), `reason` (≤ 500), `note` (≤ 500) |
| `stock_movements` | linie: `operation_id`, `material_id`, `location_id`, `quantity_delta numeric(12,3) <> 0`, `user_id`, `created_at`; indeksy (material, created_at), (location, created_at), operation_id |
| `stock` | stan bieżący: PK(material_id, location_id), `quantity numeric(12,3) CHECK >= 0`, `updated_at` |

Przyjęcie = 1 operacja + 1 ruch (+qty). Przesunięcie (Etap 5) = 1 operacja + 2 ruchy (−A, +B).

**Wiersze z zerem zostają** w `stock` (nie usuwamy przy 0). Powody: upsert przyjęcia jest jednym poleceniem bez gałęzi delete, wydanie nie musi rozróżniać „ostatnia sztuka → DELETE”, a kolejne przyjęcie w to samo miejsce ponownie użyje wiersza. Odczyty (`GET /stock`, ekran lokalizacji, „Magazyn”) filtrują `quantity > 0`. Blokady dezaktywacji porównują `quantity <> 0`, więc puste wiersze im nie przeszkadzają.

`materials.allows_fraction boolean not null` — decyzja użytkownika. Wypełnienie istniejących wierszy wg jednostki w migracji (triggery audytu wyłączone na czas tej aktualizacji — to zmiana schematu, nie edycja użytkownika). Nowy materiał bez wartości → trigger ustala ją z `app.unit_allows_fraction(unit)`: `szt`, `szt.`, `sztuka`, `sztanga`, `opak`, `opak.`, `opakowanie` (bez wielkości liter) → false, pozostałe → true. Lista rozszerzona o „sztuka”/„opakowanie” (BUSINESS_RULES używa słowa „opakowanie”). Ta sama lista w TS: `unitAllowsFraction` (podpowiedź checkboxa w formularzu materiału).

## Jedyna droga zmiany stanu: funkcje DB

- authenticated / anon / **service_role**: tylko `SELECT` na `stock`, `stock_operations`, `stock_movements` (RLS: `app.user_role() is not null`). Brak INSERT/UPDATE/DELETE — także klucz secret nie zmieni stanu bezpośrednio.
- Trigger `stock_guard_write` na `stock`: INSERT/UPDATE/DELETE tylko przy transakcyjnej fladze `forbud.stock_write`, którą ustawia (i od razu zeruje) funkcja stockowa wokół upsertu. Blokuje „magiczne” poprawianie stanu także z SQL Editora (postgres). TRUNCATE zabroniony.
- `stock_movements` i `stock_operations`: trigger BEFORE UPDATE/DELETE → `P0001 / hint IMMUTABLE`; BEFORE TRUNCATE → wyjątek. UPDATE zabroniony zawsze, także przy fladze sprzątania.

### `public.stock_receipt(p_client_request_id, p_location_id, p_material_id, p_quantity, p_supplier_id, p_document_ref, p_note) → jsonb`

SECURITY DEFINER, `search_path = ''`, EXECUTE tylko `authenticated`. Kolejność:
1. Rola `PRODUKCJA`/`ADMIN` (aktywny) — inaczej `42501`.
2. Idempotencja: `pg_advisory_xact_lock(hashtextextended('forbud.stock_op:'||id))`, potem odczyt operacji o tym `client_request_id`. Istnieje → ten sam użytkownik i te same parametry (materiał, lokalizacja, ilość, dostawca, dokument i notatka po normalizacji trim/pusty→NULL) → zwraca wynik z `idempotent_replay: true` i **bieżącym** stanem lokalizacji (stan „po operacji” nie jest przechowywany). Inny użytkownik lub inne parametry → `IDEMPOTENCY_CONFLICT` (bez ujawniania cudzej operacji). `unique(client_request_id)` = ostatnia bariera.
3. `materials … FOR UPDATE` (aktywny), `locations … FOR SHARE` (aktywna), `suppliers … FOR SHARE` (jeśli podany; aktywny).
4. Ilość: > 0, ≤ 1 000 000, ≤ 3 miejsca (`p <> round(p,3)` → `INVALID_QUANTITY`), całkowita gdy `!allows_fraction` (`NOT_INTEGER`; `2.000` jest OK).
5. INSERT operacji + ruchu, upsert `stock … on conflict do update set quantity = stock.quantity + excluded.quantity`.
6. Zwraca `{operation_id, movement_id, material_id, location_id, quantity, new_location_quantity, idempotent_replay}`.

Błędy (`P0001` + `hint`): `MATERIAL_INACTIVE`, `LOCATION_INACTIVE`, `SUPPLIER_INACTIVE`, `NOT_INTEGER`, `INVALID_QUANTITY`, `VALIDATION`, `IDEMPOTENCY_CONFLICT`, `NOT_FOUND` (`detail` = material/location/supplier). API: 400 / 404 / 409, rola → 403; przepełnienie `numeric(12,3)` (22003) → 400 `STOCK_LIMIT`.

**Dostawca**: baza zapisuje dokładnie to, co przyszło (NULL = brak/nieznany) — domyślny dostawca materiału jest **podpowiadany w UI** (preselekcja, tylko gdy aktywny). Dzięki temu porównanie przy powtórzeniu żądania jest deterministyczne (zmiana dostawcy domyślnego między próbami nie zmienia „parametrów”).

### Pozostałe funkcje

- `public.verify_stock(p_material_ids uuid[] default null)` — rozbieżności `stock.quantity` vs `Σ quantity_delta` (FULL JOIN; pusty wynik = spójnie). ADMIN albo service_role. Używana po każdym scenariuszu testów.
- `public.list_stock_movements(type, material_q, date_from, date_to, page, page_size) → {total, items}` — ADMIN, BIURO. SECURITY DEFINER, bo nazwisko wykonującego jest w `profiles` (BIURO widzi tylko własny profil); zwraca wyłącznie `full_name`, bez loginów/ról. Daty w strefie `Europe/Warsaw`, „do” włącznie; fraza z escapowaniem `\ % _`.
- Widok `v_stock` (`security_invoker = true`) — stan z kodami/nazwami/jednostką; RLS tabel bazowych obowiązuje.

## Blokady kartoteki

- `materials_z_stock_guard` (BEFORE INSERT/UPDATE, prefiks „z” — po `materials_normalize`, więc porównuje znormalizowaną jednostkę): zmiana `unit`/`allows_fraction` po pierwszym ruchu → `UNIT_LOCKED` (409); `active` true→false przy stanie ≠ 0 → `HAS_STOCK` (409; w Etapie 11 dojdą aktywne rezerwacje).
- `locations_c_stock_guard` (po `a_guard_normalize`, `b_audit`): dezaktywacja przy stanie ≠ 0 → `LOCATION_NOT_EMPTY` (409).

## Analiza współbieżności

Wszystko przy READ COMMITTED (domyślny w PostgREST); funkcje PL/pgSQL są VOLATILE, więc każde zapytanie w nich bierze nowy snapshot.

- **Równoległe przyjęcia tego samego materiału**: serializuje je `FOR UPDATE` na wierszu materiału; upsert stanu jest i tak atomowy. Test: 20 równoległych przyjęć (4 sesje, 3 konta) → stan = 210 = Σ, 20 ruchów, 20 różnych stanów „po”, `verify_stock` = 0.
- **To samo `client_request_id` równolegle**: blokada advisory na id; drugie żądanie po uzyskaniu blokady widzi zatwierdzoną operację pierwszego i zwraca replay. Test: 5× równolegle → 1 operacja, 1 ruch, 1 wynik `replay=false` + 4 `replay=true`. Przy REPEATABLE READ drugie żądanie dostałoby `23505` (API: 409 `RETRY`, ponowienie zwróci istniejący wynik) — nigdy duplikat.
- **Przyjęcie vs dezaktywacja lokalizacji**: przyjęcie trzyma `FOR SHARE` na lokalizacji; `UPDATE locations` potrzebuje `FOR NO KEY UPDATE` → czeka. Trigger BEFORE UPDATE odpala się po uzyskaniu blokady wiersza i (nowy snapshot) widzi zatwierdzony stan → `LOCATION_NOT_EMPTY`. Odwrotna kolejność: przyjęcie czeka na `FOR SHARE`, po zatwierdzeniu dezaktywacji `SELECT … FOR SHARE` zwraca najnowszą wersję (`active=false`) → `LOCATION_INACTIVE`. Oba przypadki pokryte testami SQL z dwoma połączeniami (sprawdzamy też, że druga transakcja faktycznie czeka).
- **Przyjęcie vs dezaktywacja / zmiana jednostki materiału**: ta sama analiza na wierszu materiału (`FOR UPDATE` vs `UPDATE`) → `HAS_STOCK` / `MATERIAL_INACTIVE` / `UNIT_LOCKED` (test dla `HAS_STOCK`).
- **Dostawca**: `FOR SHARE` vs dezaktywacja dostawcy — analogicznie.
- **Zakleszczenia**: kolejność blokad w funkcjach stockowych: advisory(id) → materiał → lokalizacja(e) → dostawca. Zmiany kartoteki blokują jeden wiersz i tylko czytają stock/ruchy — brak cyklu. Etap 5 (przesunięcie) musi blokować lokalizacje w stałej kolejności (np. po id).

## Sprzątanie danych testowych

Baza dev = produkcja do startu, a historia jest niemutowalna. Wybrane rozwiązanie: **funkcja `public.purge_test_stock(p_code_prefix)`**, EXECUTE wyłącznie `service_role`:
- prefiks musi pasować do `^TEST(-[A-Z0-9]{4,20})?$` (`TEST-<runId>` albo `TEST` = wszystkie pozostałości testów),
- usuwa ruchy, operacje i stany **wyłącznie materiałów `<prefiks>-%`**; operacja zawierająca materiał spoza prefiksu przerywa całość,
- ustawia transakcyjną flagę `forbud.purge_test`, którą respektują triggery: DELETE ruchu tylko dla materiału `TEST-%`, DELETE operacji tylko bez pozostałych ruchów, DELETE stanu. UPDATE nadal zabroniony.

Dlaczego nie wyjątek w triggerze dla roli `service_role`: klucz secret jest w Workerze — wyjątek „service_role może usuwać” otworzyłby kasowanie prawdziwej historii każdemu, kto uzyska ten klucz. Funkcja ogranicza szkodę do materiałów testowych. Obejście z `authenticated` jest niemożliwe: brak EXECUTE na funkcji, brak uprawnień DELETE na tabelach, a flagi nie da się ustawić przez Data API (brak dowolnego SQL, `set_config` nie jest wystawione) — test DB to potwierdza. Superuser bazy może oczywiście wyłączyć triggery — to poza modelem zagrożeń aplikacji.

**Przed startem produkcyjnym**: `drop function public.purge_test_stock(text)` (albo pominąć ją w migracjach bazy prod) i nie nadawać materiałom kodów `TEST-…`.

## API i UI

- `POST /api/v1/stock/receipts` (PRODUKCJA, ADMIN; CSRF; zod `.strict()`; ilość jako liczba albo tekst z przecinkiem) → 201 nowa / 200 replay.
- `GET /api/v1/stock?locationId=&materialId=&q=` (wszyscy), `GET /api/v1/stock/operations?type=&q=&from=&to=&page=` (ADMIN, BIURO).
- Terminal `/m/przyjecie` (skan/wpis lokalizacji → materiał → ilość → podsumowanie → ZATWIERDŹ), wejście z ekranu lokalizacji `?lokalizacja=KOD` pomija krok 1. Skaner wydzielony do `src/app/m/code-scanner.tsx` (używany też przez SKANUJ). `client_request_id` generowany przy wejściu do podsumowania; błąd sieci / 5xx = „wynik nieznany” → „Spróbuj ponownie” z TYM SAMYM id (zmiana danych zablokowana do czasu ponowienia); błąd domenowy → komunikat i „Popraw ilość” (nowy id).
- Desktop: „Magazyn” (stany), „Przyjęcia” (lista + filtry daty/materiału; ADMIN — formularz przyjęcia, ten sam endpoint).

## Ograniczenia / do zrobienia

- `new_location_quantity` przy replay to stan bieżący, nie historyczny.
- `verify_stock()` bez parametru skanuje cały ledger — do monitoringu w Etapie 6/7 wystarczy przy skali FOR-BUD.
- Brak tabeli zleceń — `production_order_id` bez FK do Etapu 8.

## Poprawki po review (migracja `20261001210000_stock_review_fixes.sql`)

Zastępują odpowiednie fragmenty powyżej.

- **Sprzątanie testów (M2):** kod materiału jest edytowalny, więc dopasowanie `code LIKE 'TEST-%'` pozwalało „przemianować” prawdziwy materiał i wyczyścić jego historię. Teraz `materials.is_test boolean not null default false`: ustawić `true` może wyłącznie `service_role` przy INSERT (authenticated → 42501), po INSERT kolumna jest niezmienna dla wszystkich. `purge_test_stock(p_material_ids uuid[] default null)` — tylko service_role (sprawdzane też wewnątrz funkcji), tylko materiały `is_test` (inne id → 22023; `null` = wszystkie testowe). Wyjątek w triggerach niemutowalności/stanu działa tylko przy fladze sprzątania **i** roli sesji `service_role` **i** `is_test`. Wariant z prefiksem kodu usunięty. Zmiana kodu materiału po ruchach nadal dozwolona dla ADMIN (historia jest po `material_id`). Test: prawdziwy materiał z ruchem przemianowany na `TEST-…` — `purge_test_stock(null)` go nie rusza, jawne wskazanie → 22023.
- **Ułamkowość (M3):** `allows_fraction` false→true zawsze dozwolone; true→false tylko gdy wszystkie ruchy materiału są całkowite (inaczej `UNIT_LOCKED`). Zmiana `unit` po ruchach nadal zablokowana. Jednostki całkowite rozszerzone o `kpl`, `kpl.`, `komplet`, `para`, `rolka` (DB i klient); backfill tylko materiałów bez ruchów.
- **Widoczność historii (M4):** PRODUKCJA czyta wyłącznie **własne** `stock_operations`/`stock_movements` (RLS) i dostaje tylko własne wiersze z `list_stock_movements` (nowy parametr `p_since`). Uzasadnienie: ROLES.md daje PRODUKCJI wykonywanie przyjęć/wydań, nie przegląd historii całego magazynu; własna historia wystarcza do „Moich ostatnich przyjęć” i sprawdzenia niepotwierdzonej operacji. Stany (`stock`, `v_stock`) widzą wszyscy. `GET /api/v1/stock/operations` jest dostępne dla wszystkich ról (PRODUKCJA — tylko własne, wymusza baza).
- **Niepewne przyjęcie na telefonie (M4, L2):** `{requestId, payload, lokalizacja, materiał, czas, userId}` w `sessionStorage` (`src/lib/pending-receipt.ts`, try/catch, kopia w pamięci gdy storage niedostępny) od wysłania do jednoznacznego wyniku (sukces albo błąd domenowy). Po odświeżeniu/powrocie na `/m/przyjecie` — ekran „Poprzednie przyjęcie nie zostało potwierdzone” (Ponów bez ryzyka duplikatu / Porzuć), na `/m` — baner „Niepotwierdzone przyjęcie — dokończ”. Przy niepewnym wyniku: `beforeunload` ostrzega, strzałka wstecz ukryta, edycja zablokowana. 401 → „Sesja wygasła — zaloguj się; przyjęcie zostanie dokończone” (zapis zostaje; po zalogowaniu baner na `/m`). Zapis starszy niż doba albo innego użytkownika jest ignorowany. Na `/m` sekcja „Moje ostatnie przyjęcia (24 h)”.
- **Desktop (M1):** ta sama zasada co na telefonie — czysta logika `src/lib/receipt-attempt.ts` (testy jednostkowe): po wyniku nieznanym/401 pola zablokowane, jedyne akcje „Ponów (ten sam id)” (wysyła dokładnie zapamiętany payload, bez ponownego rozpoznawania lokalizacji) albo „Porzuć — sprawdzę na liście przyjęć”; w trakcie wysyłania pola `disabled`.
- **L1:** `409 RETRY` (23505) traktowane w kliencie jak wynik nieznany (ponowienie tym samym id).
- **L3:** ilość `1.500` / `12.345.678` (kropka jako separator tysięcy) odrzucana z prośbą o przecinek; `,5` i `.5` = 0,5.
- **L4:** INSERT do `stock_operations`/`stock_movements` także wymaga flagi `forbud.stock_write` (ustawianej przez funkcję stockową przed zapisem historii i zerowanej po zapisie stanu).
- **L5:** przyjęcie blokuje materiał `FOR NO KEY UPDATE` (koliduje z UPDATE kartoteki i innymi operacjami na materiale, ale nie z `FOR KEY SHARE` sprawdzeń kluczy obcych). **Zasada dla operacji wielomateriałowych/wielolokalizacyjnych (Etap 5+):** najpierw materiały, potem lokalizacje, potem dostawca; w obrębie każdej grupy rosnąco po `id` — stała kolejność wyklucza zakleszczenia.
- **L6:** wspólne `formatQuantityUnit` + `endSentence` (bez „3 szt..”).
- **L7:** konta z ruchami tylko dezaktywujemy (ROLES.md) — usunięcie blokuje FK `user_id → profiles`, celowo.

## Uwagi z review (L8, L9)

- `verify_stock()` bez parametru robi pełny skan — dostępne tylko dla ADMIN/service_role; przy obecnej skali akceptowalne.
- Przepełnienie `numeric(12,3)` przy sumowaniu stanu (> 999 999 999,999) kończy się błędem 22003 mapowanym na `STOCK_LIMIT`; transakcja wycofana — akceptowalne.
