# ADR 017 — Odpowiedniki (zamienniki) materiałów (Etap 12b)

Migracja: `supabase/migrations/20261007100000_material_substitutes.sql` (NIE wgrana — `db:push` wykonuje Tech Lead).
Rozwija ADR 010 (wydania, kolejność blokad), 011 (storno), 013 (bilans, braki), 014 (rezerwacje), 016 (import).

## Decyzje użytkownika (2026-10-02)

1. W karcie materiału można przypisać odpowiedniki (narożnik XXX można zastąpić narożnikiem YYY). Relacja
   **symetryczna** (XXX↔YYY), **nieprzechodnia** (A↔B i B↔C nie daje A↔C).
2. Przelicznik zawsze **1:1**.
3. Gdy materiału z zapotrzebowania brakuje: „brak XXX, ale na stanie jest odpowiednik YYY: N” — w brakach zlecenia,
   zbiorczo i przy imporcie; akcja **„Podmień”** (BIURO/ADMIN) zamienia pozycję zapotrzebowania na odpowiednik
   z zachowaniem historii.
4. Wydanie odpowiednika na zlecenie zmniejsza „pozostało” oryginału; operacja i podsumowanie zlecenia pokazują
   „użyto zamiennika YYY za XXX”.

## Decyzje Tech Leada

A. Tabela par (kanoniczna `material_a < material_b`), zarządza ADMIN funkcjami SECURITY DEFINER; usunięcie pary
   dozwolone (konfiguracja), nie zmienia rozliczeń historycznych.
B. Rozliczenie zamiennika **zapisane przy wydaniu** (`stock_operations.substitute_for_material_id`), nie liczone
   dynamicznie. `stock_issue(+ p_substitute_for)`: **wyłącznie jawnie** (po review — H1, niżej). Storno kopiuje
   rozliczenie.
C. Bilans: wydano(XXX) += operacje z `substitute_for = XXX`; nie liczą się do wydano(YYY).
D. Rezerwacje: po CONSUME rezerwacji YYY — rezerwacja XXX zlecenia ponad nowe pozostało XXX zmniejszana zdarzeniem
   `SUBSTITUTE_RELEASE` w tej samej transakcji. Storno nie odtwarza rezerwacji.
E. „Podmień” = wycofanie listy + poprawiona kopia przez wspólny rdzeń `app.create_requirement_core`, idempotentnie.
F. Jeden helper `app.substitute_availability` dla braków zlecenia, braków zbiorczych, CSV, importu i terminala.
G. **Po review (H1) — bez automatu po stronie serwera.** Baza przypisuje zamiennik wyłącznie przy jawnym
   `p_substitute_for`. Zamiast automatu UI podpowiada w podsumowaniu wydania widoczny wybór „Policz jako zamiennik za
   XXX” (domyślnie zaznaczony; przy kilku kandydatach największe pozostało, remis po kodzie) albo „zwykłe wydanie
   (nadwydanie)”. Uzasadnienie: brak ukrytego przypisania — pracownik widzi i zatwierdza rozliczenie, a historia
   pokazuje dokładnie to, co wybrano; pomyłkę koryguje się stornem i ponownym wydaniem (z zamiennikiem albo bez).
   Kolumna `substitute_auto` i przecięcie zbioru par zostały usunięte; blokady `stock_issue` — tylko {YYY, XXX}.

## Model

| Obiekt | Opis |
|---|---|
| `material_substitutes` | `id`, `material_a`, `material_b` (FK `materials`, `on delete cascade` — wyłącznie sprzątanie testów), `created_at`, `created_by`; CHECK `material_a < material_b` (para kanoniczna, wyklucza parę z samym sobą), UNIQUE (a, b), indeks na `material_b`. RLS: SELECT dla aktywnych ról. Role aplikacyjne — tylko SELECT; `service_role` — SELECT + DELETE (bezpośredni INSERT kluczem secret → 42501, nie 23514) |
| `stock_operations.substitute_for_material_id` | FK `materials`; materiał z zapotrzebowania (XXX), za który wydano materiał ruchu (YYY) |
| CHECK `stock_operations_substitute_valid` | zamiennik tylko dla ISSUE/REVERSAL z `production_order_id` |
| trigger `stock_movements_substitute_check` | BEFORE INSERT ruchu: materiał ruchu ≠ `substitute_for` operacji (`NOT_A_SUBSTITUTE`) — materiał operacji jest dopiero w ruchu, więc CHECK na operacji nie wystarcza |
| `reservation_events.type` += `SUBSTITUTE_RELEASE` | CHECK `links`: `operation_id` + `reason` wymagane, `request_id` NULL (RELEASE wymaga `request_id` — stąd osobny typ) |

## Funkcje (SECURITY DEFINER, `search_path=''`, REVOKE/GRANT jak w istniejących)

- `add_material_substitute(material, substitute)` — ADMIN (inaczej 42501); `VALIDATION`, `SAME_MATERIAL`, `NOT_FOUND`,
  `MATERIAL_INACTIVE` (nowej pary z nieaktywnym nie zakładamy; istniejąca para materiału zdezaktywowanego zostaje);
  oba materiały `FOR NO KEY UPDATE` rosnąco; istniejąca para → sukces `already_existed = true` (idempotentnie).
- `remove_material_substitute(id)` — ADMIN; `NOT_FOUND`; blokuje oba materiały rosnąco, usuwa parę.
- `material_substitute_list(material)` — każda aktywna rola: odpowiedniki (także nieaktywne — do usunięcia pary)
  ze stanem/rezerwacjami/wolnym.
- `app.substitute_availability(material_ids[], order_id = null)` — per materiał jsonb aktywnych odpowiedników
  `{material_id, code, name, unit, allows_fraction, free, own_reserved, available}`; `free` jak `app.material_free`,
  `own_reserved` = rezerwacja zlecenia na odpowiednik, `available = free + own_reserved`; sortowanie: available ↓, kod.
- `app.requirement_balance` — jedyna zmiana: `coalesce(substitute_for_material_id, materiał ruchu)` w agregacji
  wydań (nadal CTE MATERIALIZED, ta sama sygnatura). Dziedziczą: `order_shortages`, `order_overview`, `order_to_issue`,
  `shortage_rows`, `reserve_for_order`, `order_reservations`, `reservations_over_requirement`,
  `release_reservation_excess`.
- `app.create_requirement_core(..., p_allow_inactive uuid[] = null)` — po review (M2a): materiały dozwolone mimo
  nieaktywności, przekazywane WYŁĄCZNIE przez „Podmień” (pozycje kopiowane z listy źródłowej, w tym część XXX).
  `create_requirement` / `import_requirement` wołają rdzeń z 8 argumentami — zachowanie bez zmian (DROP + CREATE).
- `stock_issue(..., p_override_reason, p_substitute_for uuid = null)` — nowa sygnatura (stara 10-parametrowa
  usunięta; stare wywołania, także pozycyjne z 10 argumentami, działają). Zmiany względem `20261004100000`:
  - walidacja: zamiennik tylko przy wydaniu na zlecenie (`ISSUE_TARGET`), ≠ materiał (`NOT_A_SUBSTITUTE`);
  - jawny XXX: para musi istnieć (`NOT_A_SUBSTITUTE`), XXX na liście ACTIVE zlecenia (`NOT_IN_REQUIREMENTS`, detail =
    kod); dozwolony także, gdy pozostało XXX = 0 (nadwydanie jest dozwolone jak zwykle);
  - XXX bez ułamków (M2c): ułamkowa ilość zamiennika → `NOT_INTEGER` (detail = kod XXX) — rozliczenie 1:1 nie może
    dać oryginałowi ułamkowego „wydano”;
  - bez `p_substitute_for` — zawsze zwykłe wydanie (H1);
  - cała ilość operacji przypisana do XXX — operacja nie jest dzielona (L1 z review nieaktualne: przy jawnym wyborze
    nadwyżkę ponad pozostało XXX widać w Brakach jako nadwydanie XXX; podział robi się dwoma wydaniami);
  - idempotencja: przy replay `p_substitute_for` porównywane jak override (musi być identyczne, także NULL);
  - rezerwacje: najpierw CONSUME rezerwacji YYY (bez zmian), potem (krok 5c/6b) jeśli zlecenie ma rezerwację XXX >
    nowe pozostało XXX (`max(potrzebne − wydano − ilość, 0)`) → zmniejszenie o `least(ilość, rezerwacja − pozostało)`
    (L2: najwyżej ilość wydania — nadmiar sprzed wydania zostaje dla „Zwolnij nadmiar”), zdarzenie
    `SUBSTITUTE_RELEASE` (powód „Użyto zamiennika <kod YYY>”, autor = wydający, `operation_id`);
  - wynik: `substitute_for {material_id, code, name}` | null, `substitute_reservation_released`
    (replay odtwarza z operacji i zdarzeń).
- `stock_reverse` — INSERT REVERSAL kopiuje `substitute_for_material_id` (storno zamiennika
  zwiększa pozostało XXX). Rezerwacji nie odtwarza (ADR 014). Sygnatura bez zmian.
- `substitute_requirement_item(crid, requirement, from, to, reason = null)` — BIURO/ADMIN (42501). Kolejność:
  walidacja (`VALIDATION`, `NOT_A_SUBSTITUTE` dla from = to, powód ≤ 200) → advisory(crid) + replay → **blokady
  (M1): materiały {from, to} `FOR NO KEY UPDATE` rosnąco → wiersz listy `FOR UPDATE` → zlecenie `FOR SHARE`** → lista
  istnieje (`NOT_FOUND`), ACTIVE (`ALREADY_WITHDRAWN`), zlecenie OPEN/IN_PRODUCTION (`ORDER_NOT_OPEN`), pozycja na liście
  (`NOT_IN_REQUIREMENTS`), para (`NOT_A_SUBSTITUTE`), cel istnieje i aktywny (`MATERIAL_INACTIVE`) → jeden odczyt
  bilansu XXX (pod blokadą XXX) → podział (niżej; dla XXX bez ułamków `keep = least(ilość, ceil(keep))` — M2b;
  `NOTHING_TO_SUBSTITUTE`) → `withdraw_requirement` (ta sama funkcja co „Wycofaj”: blokada wiersza listy,
  `ALREADY_WITHDRAWN` pod blokadą; powód „Podmiana XXX → YYY — dopisek”, przycięty do 200) → kopia przez
  `app.create_requirement_core` (ta sama nazwa, `source`, `imported_file_name`, `import_format`; pozostałe pozycje
  z notatkami i `raw_source_ref`, także materiały nieaktywne — M2a; YYY już na liście → suma, notatka „…; zamiennik za
  XXX”; `NOT_INTEGER` z rdzenia cofa całość). Wynik: `requirement_id` (nowa lista),
  `order_id`, `withdrawn_requirement_id`, `moved_quantity`, `kept_quantity`, `idempotent_replay`.
  - **Idempotencja**: `client_request_id` = id nowej listy; zakres odcisku `SUBST:<lista>|<from>|<to>|<powód>`.
    Powtórzenie: odcisk liczony z ZAPISANYCH pozycji nowej listy (niezmienne) i parametrów — ten sam użytkownik i
    te same parametry → replay (200, `moved_quantity` / `kept_quantity` odtworzone z list); inne → `IDEMPOTENCY_CONFLICT` (także id użyte wcześniej przez
    `create_requirement`/import).
  - Rezerwacje XXX zostają (jak przy wycofaniu listy, ADR 014 M1b) — sekcja Rezerwacje pokazuje istniejące
    ostrzeżenie „rezerwacje ponad zapotrzebowanie” i „Zwolnij nadmiar”.
- `order_shortages` (+ `substitutes`, available = wolne + rezerwacja zlecenia), `order_to_issue` (+ `substitutes`),
  `shortages_summary` (+ `substitutes`, wolne bez zlecenia; `app.shortage_rows` bez zmian — odpowiedniki liczone
  tylko dla zwracanej strony), `resolve_import_codes` (+ `free`, `substitutes`) — zmiana typu wyniku → DROP + CREATE
  z REVOKE/GRANT. `export_shortages_csv` — nowa kolumna „Odpowiedniki na stanie” NA KOŃCU („KOD (wolne N)”, tylko
  wolne > 0).
- `order_issue_summary` (DROP + CREATE, SECURITY INVOKER jak dotąd) — wiersz per (materiał, zamiennik za):
  `substitute_for_id/code/name`.
- `list_stock_movements` (ta sama sygnatura) — pola `substitute_for_material_id`, `substitute_for_code`,
  `substitute_for_name`.
- `purge_test_stock` — bez zmian: operacje zamienników mają ruchy materiałów testowych (usuwane jak dotąd), zdarzenia
  `SUBSTITUTE_RELEASE` są zdarzeniami rezerwacji materiałów testowych, pary znikają kaskadą przy usuwaniu materiałów
  testowych (testy mogą też usuwać je bezpośrednio — `service_role` ma DELETE).

### Kolejność blokad (rozszerza ADR 010/011/014)

`advisory(client_request_id)` → **materiały `FOR NO KEY UPDATE` rosnąco po id** → zlecenie `FOR SHARE` → lokalizacje →
wiersze `stock` → wiersze `reservations` `FOR UPDATE`.

W `stock_issue` blokowany jest zbiór {wydawany YYY, jawny XXX} jednym zapytaniem rosnąco — jak w każdej innej
funkcji wielomateriałowej (`reserve_for_order`, `release_reservation(_excess)`, `stock_reverse`, zatwierdzenie
inwentaryzacji, `add/remove_material_substitute`, „Podmień”). „Podmień”: advisory(crid) → materiały {from, to}
rosnąco → wiersz listy `FOR UPDATE` → zlecenie `FOR SHARE` (w `withdraw_requirement` i rdzeniu te same blokady są
już trzymane). Dlaczego bez cyklu:

1. Każda funkcja bierze blokady materiałów na początku (po advisory / wierszu oryginału storna, których nikt inny
   nie trzyma przy czekaniu na materiał) i w tej samej kolejności rosnącej — oczekiwanie na materiał zawsze idzie „w
   górę” po id, więc cykl między blokadami materiałów jest niemożliwy.
2. Para zmienia się tylko pod blokadą obu jej materiałów, a `stock_issue` sprawdza parę pod blokadą YYY i XXX —
   sprawdzenie jest stabilne do końca transakcji.
3. **Wydanie zamiennika ∥ „Podmień” (M1)**: oba trzymają blokadę XXX, więc są serializowane. Podział „Podmień” liczony
   jest po blokadzie — uwzględnia każde zatwierdzone wcześniej wydanie XXX / zamiennika za XXX; wydanie po podmianie
   widzi nową listę (gdy XXX zniknął z zapotrzebowania → `NOT_IN_REQUIREMENTS`). Dwie listy z XXX i „Podmień” na obu
   równolegle — serializowane na XXX, każda liczy podział z aktualnego bilansu.
4. Wiersz listy blokują tylko „Wycofaj” (bez materiałów) i „Podmień” (po materiałach); funkcje stockowe i zmiana
   statusu zlecenia nie czekają na listy. „Podmień” czeka na zlecenie `FOR SHARE` dopiero po materiałach i liście;
   zamknięcie zlecenia (UPDATE) nie bierze ani materiałów, ani list — brak cyklu.
5. Wiersz rezerwacji (X, XXX): zmienia go wyłącznie ktoś z blokadą materiału XXX (trzymamy ją) albo auto-zwolnienie
   zlecenia X (wykluczone, bo trzymamy zlecenie `FOR SHARE`, a trigger działa po UPDATE wiersza zlecenia) — ta
   blokada nigdy nie czeka, więc nie może domknąć cyklu, mimo że bywa brana po wierszach rezerwacji YYY.

## API (CSRF, zod `.strict()`, role w handlerze i ponownie w bazie: 42501 → 403)

| Endpoint | Role | Odpowiedzi |
|---|---|---|
| `GET /api/v1/materials/[id]/substitutes` | wszystkie aktywne | `{ items }` |
| `POST /api/v1/materials/[id]/substitutes` `{substitute_id}` | ADMIN | 201 nowa / 200 istniała / 400 `SAME_MATERIAL`, `MATERIAL_INACTIVE` / 404 |
| `DELETE /api/v1/materials/[id]/substitutes/[pairId]` | ADMIN | 200 / 404 |
| `POST /api/v1/requirements/[id]/substitute` `{client_request_id, from_material_id, to_material_id, reason?}` | ADMIN, BIURO | 201 / 200 replay / 400 `NOT_A_SUBSTITUTE`, `NOT_IN_REQUIREMENTS`, `MATERIAL_INACTIVE`, `NOT_INTEGER` / 409 `ALREADY_WITHDRAWN`, `NOTHING_TO_SUBSTITUTE`, `ORDER_NOT_OPEN`, `IDEMPOTENCY_CONFLICT` |
| `POST /api/v1/stock/issues` + `substitute_for` | PRODUKCJA, ADMIN | 400 `NOT_A_SUBSTITUTE`, `NOT_IN_REQUIREMENTS`; wynik + `substituteFor`, `substituteReservationReleased` |

Rozszerzone odpowiedzi: `/orders/[id]/shortages`, `/orders/[id]/to-issue`, `/shortages` (+ `substitutes[]`),
`/import/resolve` (+ `material.free`, `material.substitutes`), `/stock/movements` (+ `substituteForCode/Name`),
podsumowanie zlecenia (+ `substituteFor`). CSV braków: kolumna „Odpowiedniki na stanie” na końcu.

## UI

- **Karta materiału** (`/materialy/[id]`, ADMIN/BIURO): sekcja „Odpowiedniki” — kod, nazwa, jednostka, wolne;
  ADMIN: „Dodaj odpowiednik” (wyszukiwarka aktywnych materiałów; blokada pary z samym sobą i duplikatu; ostrzeżenie
  o różnych jednostkach — przelicznik i tak 1:1), „Usuń” z potwierdzeniem (historia zostaje). Ostatnie ruchy:
  „zamiennik za XXX”.
- **Braki zlecenia** (`/zlecenia/[id]`, komponent kliencki `shortages-section.tsx`): kolumna „Odpowiedniki na stanie”
  przy wierszach z brakiem („YYY — dostępne N”, ostrzeżenie o innej jednostce) + „Podmień” (zlecenie OPEN /
  IN_PRODUCTION): panel z wyborem listy (gdy materiał jest na kilku listach ACTIVE), podglądem podziału
  (`substituteSplit` — jak w SQL), informacją o rezerwacji XXX, która zostaje, i opcjonalnym powodem. Ten sam
  `client_request_id` przy ponowieniu identycznej podmiany po błędzie sieci. Komunikat sukcesu z ilości zwróconych
  przez serwer (`movedQuantity` / `keptQuantity` — L4).
- **Podsumowanie zlecenia**: wiersz zamiennika „użyto zamiennika YYY za XXX (nazwa)”; lista wydań: „zamiennik za XXX”. Historia rezerwacji: „Zwolniono (wydano zamiennik)” z linkiem do operacji.
- **/braki**: dopisek „odpowiedniki: YYY (wolne N)” przy materiałach z brakiem; CSV — nowa kolumna.
- **Import** (podgląd): przy pozycji gotowej z ilością > wolne — „Na stanie wolne: N — odpowiednik YYY: M (podmiana
  po zapisie — w Brakach zlecenia)”. Tylko informacja: lista zapisuje się z oryginałem, podmianę wykonuje się
  po zapisie w Brakach zlecenia (jedna ścieżka podmiany z historią — wycofana lista + kopia).
- **Terminal WYDANIE**: w „Do wydania na to zlecenie” przy pozycji XXX z dostępne < pozostało — przyciski
  „Odpowiednik YYY: dostępne N — wydaj jako zamiennik za XXX”; tapnięcie wybiera YYY (dalej lokalizacja), podpowiedź
  ilości = min(pozostało XXX, dostępne YYY dla zlecenia, w lokalizacji) (`suggestSubstituteQuantity`, całości dla
  materiałów bez ułamków; dane zamiennika przekazywane parametrem do `pickStockRow` — `suggestQuantityForRow`, L3);
  kontekst „Materiał — zamiennik za XXX”, podsumowanie „Zamiennik za XXX”, ekran wyniku „Zamiennik za XXX” i
  zmniejszona rezerwacja XXX. **H1:** gdy materiał wybrany inaczej (wyszukiwarka, lokalizacja) nie ma „pozostało” na
  zleceniu, a jest odpowiednikiem pozycji z pozostało > 0 (`substituteCandidates` z danych `order_to_issue`),
  podsumowanie pokazuje duże przełączniki „Policz jako zamiennik za XXX” (domyślnie największe pozostało, remis po
  kodzie) i „Zwykłe wydanie (nadwydanie)”. Zamiennik zapisany w niepotwierdzonej operacji (`ctx.substituteFor` ↔
  `payload.substitute_for`, sprawdzane w `parsePending`).
- **Desktop „Wydania”** (ADMIN): przy wydaniu na zlecenie, gdy wybrany materiał nie ma „pozostało”, a jest
  odpowiednikiem pozycji z pozostało > 0 — widoczne pole „Policz jako zamiennik za: [XXX (pozostało N) … / Zwykłe
  wydanie (nadwydanie)]”, domyślnie pierwszy kandydat (`substituteCandidates`, dane z `order_to_issue`); komunikat
  sukcesu „(zamiennik za XXX)”; lista wydań — „zamiennik za XXX”.
- **Historia ruchów**: w szczegółach operacji „Zamiennik za XXX (nazwa)”; panel cofnięcia
  informuje, że „pozostało” XXX wzrośnie.

## Decyzje własne (implementer)

- **„Podmień” zachowuje część już wydaną jako oryginał.** Ilość przenoszona na YYY = ilość pozycji minus część XXX
  już pokryta wydaniami (wydano XXX — wraz z zamiennikami za XXX — ponad zapotrzebowanie XXX z innych list ACTIVE;
  `keep = min(ilość, max(wydano − (potrzebne − ilość), 0))`). Ta część zostaje na kopii jako XXX (notatka „wydane
  przed podmianą na YYY”). Bez tego „pozostało” YYY obejmowałoby ilość już wydaną (np. lista 10 XXX, wydano 4 XXX →
  po podmianie 1:1 trzeba by wydać 10 YYY). Całość wydana → `NOTHING_TO_SUBSTITUTE`. Przelicznik nadal 1:1 dla
  przenoszonej części. **Do potwierdzenia przez Tech Leada/użytkownika** (TL zapisał „ilość 1:1” bez tego przypadku).
- `raw_source_ref` pozycji YYY w kopii: własny YYY, a gdy go nie ma — odwołanie z pozycji XXX (ślad pochodzenia).
- `add_material_substitute` idempotentne (istniejąca para = sukces 200) i odrzuca materiał nieaktywny.
- `material_substitute_list` dostępne dla każdej aktywnej roli (PRODUKCJA może zobaczyć odpowiedniki — odczyt).
- Wydanie jawnego zamiennika jest dozwolone także, gdy pozostało XXX = 0 (jak zwykłe nadwydanie).
- Trigger na `stock_movements` zamiast CHECK „≠ materiał” (materiał operacji jest w ruchu).
- Usunięcie pary (DELETE) w API nie sprawdza, czy para dotyczy materiału z URL — funkcja usuwa po id pary (ADMIN).

## Ograniczenia

- Brak historii zmian par (konfiguracja; usunięcie nie zmienia rozliczeń).
- Wydania XXX wykonane przed podmianą, gdy XXX znika z zapotrzebowania (np. ręczne wycofanie listy bez „Podmień”), nie
  zmniejszają „pozostało” YYY — rozliczenie jest per materiał zapisany w operacji (ADR 013: wydania bez pozycji nie
  liczą się nigdzie). „Podmień” obsługuje ten przypadek podziałem (decyzja własna wyżej).
- Lista dodana równolegle przez `create_requirement` / import (bez blokad materiałów) nie jest serializowana z
  „Podmień” — nie wpływa na podział (liczony z list ACTIVE w chwili odczytu), a jej pozycje sumują się w bilansie.
- L7 z review (pominięte decyzją TL): `created_at` zdarzeń rezerwacji z jednej transakcji jest równy — kolejność
  CONSUME / SUBSTITUTE_RELEASE w historii rozstrzyga id, nie czas.
- Import nie podmienia pozycji na podglądzie — tylko informacja; podmiana po zapisie w Brakach zlecenia.
- Przelicznik zawsze 1:1, także przy różnych jednostkach (decyzja użytkownika) — UI ostrzega.
- Terminal po wznowieniu niepotwierdzonego wydania zamiennika nie zna już „pozostało” oryginału (podpowiedź ilości
  przy ewentualnej poprawce nie jest liczona).
- Testy współbieżności (`tests/db/substitutes.test.ts`) wymagają wgranej migracji (`pnpm db:push`) — nie były
  uruchamiane przez implementera; SQL zweryfikowany na lokalnym PGlite (jedno połączenie — bez współbieżności).

## Weryfikacja

- PGlite (wszystkie migracje + nowa; atrapy `auth.users`/`auth.uid()` i ról): 72 scenariusze (po review) — pary
  (role, walidacje, idempotencja, nieprzechodniość, bezpośredni INSERT 42501 dla `authenticated` i `service_role`),
  braki/terminal z odpowiednikami, wydanie jawne (błędy, bilans, kolumny), brak automatu (wydanie bez wskazania =
  zwykłe), replay/konflikty, `SUBSTITUTE_RELEASE` i L2 (zwolnienie ≤ ilość), M2c (`NOT_INTEGER` z kodem XXX), storno
  (kopiowanie, bez odtwarzania rezerwacji), usunięcie pary (bilans bez zmian), podsumowanie i historia, „Podmień”
  (podział, kopia IMPORT, replay z moved/kept, konflikty, `ALREADY_WITHDRAWN`, `NOTHING_TO_SUBSTITUTE`, nieaktywny cel,
  M2a nieaktywna pozycja kopii, M2b `ceil` przy ułamkowym „wydano” XXX bez ułamków, zamknięte zlecenie, nadmiar
  rezerwacji), braki zbiorczo/CSV/import, trigger i CHECK, purge + kaskada par, `verify_stock` puste, rezerwacja =
  Σ zdarzeń, stare wywołanie `stock_issue`.
- Komendy: `pnpm lint`, `pnpm typecheck`, `pnpm test` (34 pliki, 986 testów — po review), `pnpm build`, `pnpm cf:build`, `pnpm check:size` — Worker gzip po review: 1971,8 KiB / 2560 KiB (77%).
- Wydajność (PGlite, bez ANALYZE; 400 zleceń, 5600 pozycji, 3200 operacji, w tym 800 zamienników, ~390 par):
  `requirement_balance(NULL)` ≈ 18,6 ms (poprzednia definicja ≈ 19,2 ms na tych samych danych), `shortage_rows` ≈ 40 ms,
  `substitute_availability` dla 200 materiałów ≈ 7 ms.

## Poprawki po review (ta sama migracja, przed db:push)

- **H1** — usunięty automat po stronie serwera (decyzja TL G wyżej): kolumna `substitute_auto` i logika automatu
  usunięte, replay porównuje tylko jawne `p_substitute_for`, blokady {YYY, XXX}; podpowiedź w UI (terminal —
  przełączniki w podsumowaniu, desktop — pole wyboru), czysta funkcja `substituteCandidates` + testy unit.
- **M1** — „Podmień” blokuje materiały {from, to} przed listą i zleceniem; testy współbieżności: Podmień czeka na
  wydanie zamiennika (i odwrotnie), dwie listy z XXX ∥ Podmień na obu.
- **M2** — (a) kopia przyjmuje nieaktywne pozycje listy źródłowej (`p_allow_inactive` rdzenia); (b) `ceil` części
  zachowanej dla XXX bez ułamków; (c) `NOT_INTEGER` dla ułamkowego zamiennika za XXX bez ułamków.
- **L2** — `SUBSTITUTE_RELEASE` ≤ ilość wydania. **L3** — dane zamiennika parametrem `pickStockRow`
  (`suggestQuantityForRow` + test). **L4** — komunikat Podmień z ilości z serwera. **L5** — jeden odczyt bilansu.
  **L1** — nieaktualne (operacja nie jest dzielona — patrz `stock_issue`). L6 pominięte; L7 — notka w Ograniczeniach.

## Postęp

- [x] Migracja (PGlite) — `db:push`: Tech Lead
- [x] Serwer/API, UI desktop, terminal
- [x] Testy unit (`tests/unit/substitutes.test.ts`, `tests/unit/substitutes-routes.test.ts`); testy DB
  `tests/db/substitutes.test.ts` (do uruchomienia po `db:push`); zaktualizowany nagłówek CSV w
  `tests/db/requirements-shortages.test.ts`
- [ ] test:db, przeklikanie (desktop + terminal 375 px), Reviewer

## Poprawki po re-review

1. „Podmień”: gdy YYY jest bez ułamków, a XXX z ułamkami — `keep = ilość − floor(ilość − keep)`, czyli na YYY przechodzi
   część całkowita, ułamek zostaje jako XXX (XF 10, wydano 2,5 → zostaje 3, przenosi 7; PGlite + test DB).
2. Terminal i desktop: podpowiedź ilości zamiennika (`suggestQuantityForRow`) i walidacja przed wysłaniem
   (`substituteQuantityError`) uwzględniają `allowsFraction` ORYGINAŁU — bez podpowiadania ułamka, którego baza nie
   przyjmie (`NOT_INTEGER`); komunikat zawiera kod XXX. W podsumowaniu terminala kandydat niedopuszczalny dla ilości
   jest zablokowany z komunikatem; domyślny wybór — pierwszy dopuszczalny (`defaultSubstituteChoice`).
3. Terminal: gdy przy wejściu w podsumowanie lista „do wydania” jest w stanie wczytywania / błędu, jest dociągana;
   przy błędzie — „Nie udało się sprawdzić odpowiedników” + „Ponów” / „Wydaj jako zwykłe wydanie”; ZATWIERDŹ zablokowany
   do czasu rozstrzygnięcia (bez cichego zwykłego wydania).

Weryfikacja: lint, typecheck, test (989), build; PGlite 75/75. cf:build / check:size nie powtarzane — w komponentach
klienckich nie doszły nowe moduły (te same importy z `@/lib/substitutes` i `@/lib/to-issue`).
