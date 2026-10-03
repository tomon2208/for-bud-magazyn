# ADR 015 — Inwentaryzacja (Etap 13)

Migracje: `supabase/migrations/20261005100000_inventory.sql` i `20261005110000_inventory_expected_counts.sql` (obie wgrane). Rozwija ADR 009 (ledger, flagi zapisu),
010 (kolejność blokad), 011 (korekta: STOCK_CHANGED, nieaktywne tylko w dół, storno), 014 (rezerwacje).

## Decyzje użytkownika (2026-10-03)

1. Sesja inwentaryzacyjna na wybrane lokalizacje (wszystkie aktywne / prefiks kodu, np. „A-” / zaznaczenie). Tworzy
   BIURO/ADMIN. Statusy OPEN → CLOSED albo CANCELLED. Lokalizacja w co najwyżej jednej OTWARTEJ sesji.
2. Ruchy NIE są blokowane — ruch materiału w lokalizacji po liczeniu → pozycja „do ponownego policzenia” (RECOUNT).
3. Liczenie na ślepo — liczący nie widzi stanu systemowego ani różnic.
4. Liczy PRODUKCJA (i ADMIN) na telefonie; ponowne liczenie nadpisuje liczenie (to nie ruch), z historią.
5. Zatwierdza BIURO lub ADMIN (świadomy wyjątek od „BIURO bez korekt” — ROLES.md): operacja `INVENTORY` z ruchami
   różnic; zgodne bez ruchu; niepoliczone NIE są zerowane; materiał oczekiwany, ale niewpisany = niepoliczony.
6. Rezerwacje: bez automatycznych zmian; nadrezerwacja pokazywana przed zatwierdzeniem.
7. Nieaktywne lokalizacje/materiały: różnica w górę zablokowana (jak korekta — tylko w dół).

## Model

| Tabela | Opis |
|---|---|
| `inventory_sessions` | nazwa (1–120), notatka, status `OPEN/CLOSED/CANCELLED`, `created_*`, `closed_*`, `cancelled_*`, `cancel_reason`; CHECK spójności pól ze statusem |
| `inventory_session_locations` | PK (sesja, lokalizacja), `is_open` (true dopóki sesja otwarta), `counted_at/by` (ostatni zapis liczenia); **unikalny indeks częściowy `(location_id) WHERE is_open`** — lokalizacja w jednej otwartej sesji (ostatnia bariera) |
| `inventory_counts` | bieżące liczenie (sesja, lokalizacja, materiał) UNIQUE: `counted_quantity numeric(12,3)` 0…1 000 000, `counted_by/at`, znacznik stanu (`count_started_at`, `baseline_movement_count`, `baseline_quantity`), `status` `COUNTED/RECOUNT/APPROVED/MATCHED`, `operation_id` (APPROVED), `approved_by/at`; CHECK spójności statusu |
| `inventory_count_events` | historia (append-only): `COUNT` (nowa + poprzednia wartość), `REMOVE` (poprzednia), `RECOUNT`, `APPROVE` (z operacją), `MATCH`; autor, czas, `request_id` |
| `inventory_requests` | idempotencja: id = `client_request_id`, rodzaj (`CREATE/COUNT/APPROVE/CLOSE/CANCEL`), sesja, użytkownik, odcisk md5 parametrów, wynik zwracany przy powtórzeniu |
| `stock_operations.inventory_session_id` | FK; CHECK `stock_operations_inventory_link`: `INVENTORY ⇔ NOT NULL` (przed wgraniem 0 operacji INVENTORY) |

**Ochrona zapisu** (jak rezerwacje): role aplikacyjne i `service_role` mają tylko SELECT; trigger
`app.inventory_guard_write` przepuszcza zapis wyłącznie przy transakcyjnej fladze `forbud.inventory_write` (sesje
i lokalizacje sesji INSERT/UPDATE, liczenia INSERT/UPDATE/DELETE, historia i żądania tylko INSERT); TRUNCATE zabroniony;
wyjątek DELETE tylko przy `forbud.purge_test` + sesja `service_role` (liczenia/historia materiałów `is_test`, sesje
`TEST-…`). Zmiana stanu — flaga `forbud.stock_write` jak w innych funkcjach stockowych.

**RLS SELECT**: sesje i lokalizacje sesji — każdy aktywny (wybór sesji na terminalu; bez danych systemowych);
`inventory_counts` (zawiera `baseline_quantity`), `inventory_count_events`, `inventory_requests` — tylko ADMIN/BIURO.

## Wykrywanie ruchu po liczeniu (znacznik stanu)

- Ekran liczenia (`inventory_counting_location`) zwraca `server_time` = `clock_timestamp()` bazy — chwilę otwarcia
  lokalizacji do liczenia. Terminal odsyła ją przy zapisie (`p_started_at`); baza przyjmuje `least(p_started_at, now())`,
  odrzuca czas z przyszłości (> 5 min, `VALIDATION`) i starszy niż 12 h (`COUNT_STALE` — otwórz lokalizację ponownie).
  Klient nie może tym ukryć cudzego ruchu bardziej niż zwlekając z zapisem — to i tak jego deklaracja liczenia.
- Znacznik pozycji = **liczba ruchów** i **suma delt** (materiał, lokalizacja) z `created_at < count_started_at`.
  Liczba ruchów jest monotoniczna (ruchów nie usuwamy; storno to nowy ruch), więc każdy ruch po rozpoczęciu liczenia ją
  zmienia. Ruch w transakcji rozpoczętej przed liczeniem, a zatwierdzonej później, nie trafi do znacznika (nie był
  widoczny przy zapisie) — przy zatwierdzaniu liczba ruchów jest większa → RECOUNT (bezpieczny kierunek).
- Zatwierdzanie: pod blokadą materiału i wiersza stanu (READ COMMITTED, nowy snapshot) liczba ruchów ≠ znacznik **albo**
  stan ≠ `baseline_quantity` → status `RECOUNT` (zdarzenie RECOUNT), bez różnicy. Analogia do STOCK_CHANGED z ADR 011.
- Tabela zatwierdzania i ekran liczenia pokazują RECOUNT także „na żywo” (liczba ruchów ≠ znacznik), zanim ktoś
  spróbuje zatwierdzić. Liczący widzi tylko, że pozycję trzeba policzyć ponownie — bez ilości.
- Ponowne liczenie (nowy zapis lokalizacji) odświeża znacznik i ustawia `COUNTED`.
- Ograniczenie: ruch zarejestrowany po zatwierdzeniu, choć fizycznie wykonany przed liczeniem, zmieni stan po
  inwentaryzacji (np. wydanie wpisane z opóźnieniem) — tego żaden znacznik nie wykryje; wymaga dyscypliny rejestracji.

## Liczenie na ślepo

- `inventory_counting_location` (każda aktywna rola; API: PRODUKCJA, ADMIN) zwraca materiały oczekiwane
  (`stock.quantity > 0` w lokalizacji) **bez ilości** (`expected: true`), zapisane liczenia (ilość wpisana przez
  liczących, kto/kiedy) i stan pozycji `COUNTED/RECOUNT/APPROVED` (zatwierdzone różnice i zgodne są pokazywane tak samo —
  liczący nie dowiaduje się, czy była różnica). Serwis mapuje jawną listą pól.
- `GET /api/v1/inventory/sessions/[id]`: PRODUKCJA dostaje tylko nagłówek i lokalizacje z postępem; BIURO/ADMIN —
  dodatkowo wiersze tabeli zatwierdzania i historię. `inventory_session_review`, `inventory_session_events`,
  `export_inventory_csv` — 42501 dla PRODUKCJI. Wynik zapisu liczenia nie zawiera stanów.
- **Świadome ograniczenie:** PRODUKCJA ma od Etapu 4 SELECT na `stock`/`v_stock` (ekran lokalizacji, SZUKAJ, wydanie
  pokazują stany). Nie przebudowujemy RLS — „na ślepo” dotyczy ekranu liczenia i API inwentaryzacji, nie całej aplikacji.
  Pracownik, który celowo otworzy ekran lokalizacji, zobaczy stan — to akceptowane (decyzja Tech Leada/użytkownika).
- Wyszukiwarka „Dodaj inny materiał” korzysta z `/api/v1/materials` — zwraca kartotekę bez stanów.

## Funkcje (SECURITY DEFINER, `search_path=''`, rola sprawdzana w funkcji)

| Funkcja | Rola | Opis |
|---|---|---|
| `inventory_create_session(crid, name, note, location_ids[], code_prefix, all_locations)` | BIURO, ADMIN | dokładnie jeden sposób wyboru; zaznaczone muszą być aktywne (`LOCATION_INACTIVE`, `NOT_FOUND`); prefiks (UPPER, LIKE z escapowaniem) i „wszystkie” biorą aktywne; brak → `NO_LOCATIONS`; lokalizacja w otwartej sesji → `LOCATION_IN_OPEN_SESSION` (detail: kody + nazwa sesji). Tworzenie szeregowane globalną blokadą advisory (kontrola widzi zatwierdzone sesje); unikalny indeks częściowy — ostatnia bariera (23505 → 409) |
| `inventory_save_location_count(crid, session, location, items jsonb, started_at)` | PRODUKCJA, ADMIN | pełny stan liczenia lokalizacji (≤ 500 pozycji, 0 dozwolone, `DUPLICATE_MATERIAL`, `INVALID_QUANTITY`, `NOT_INTEGER` wg `allows_fraction`, `NOT_FOUND`); sesja `FOR SHARE` (OPEN, inaczej `SESSION_NOT_OPEN`), wiersz lokalizacji sesji `FOR UPDATE` (`LOCATION_NOT_IN_SESSION`); upsert liczeń + znacznik + zdarzenia COUNT; niezatwierdzone pozycje spoza nowej listy usuwane (REMOVE); zatwierdzone: ta sama ilość → bez zmian, inna → `ALREADY_APPROVED`; lokalizacja „policzona” (`counted_at/by`) |
| `inventory_approve(crid, session, count_ids[] = null)` | BIURO, ADMIN | patrz niżej |
| `inventory_close_session(crid, session)` | BIURO, ADMIN | OPEN → CLOSED, zwalnia lokalizacje; zwraca liczbę niepoliczonych lokalizacji i niezatwierdzonych pozycji (nic nie zeruje) |
| `inventory_cancel_session(crid, session, reason?)` | BIURO, ADMIN | OPEN → CANCELLED, tylko bez zatwierdzonych pozycji (`SESSION_HAS_APPROVALS`) |
| `inventory_sessions_list(status?)`, `inventory_session_overview(session)` | każdy aktywny | lista z postępem, nagłówek + lokalizacje (bez stanów) |
| `inventory_counting_location(session, location)` | każdy aktywny | ekran liczenia (na ślepo) |
| `inventory_session_review(session)` | BIURO, ADMIN | wiersze tabeli: liczenia + UNCOUNTED (materiał oczekiwany w POLICZONEJ lokalizacji, niewpisany); stan teraz, policzono, różnica (dla APPROVED — wprowadzona delta), status `OK/DIFF/RECOUNT/APPROVED/MATCHED/UNCOUNTED`, `blocked_reason` (`MATERIAL_INACTIVE`, `LOCATION_INACTIVE`, `NOT_INTEGER`), operacja i czy cofnięta, stan aktywny i rezerwacje materiału (ostrzeżenie o nadrezerwacji) |
| `inventory_session_events(session)` | BIURO, ADMIN | historia liczeń z nazwiskami (maks. 1000) |
| `export_inventory_csv(session, only_diff)` | BIURO, ADMIN | CSV w SQL (`app.csv_*`, BOM dokleja route handler) |

Idempotencja wszystkich zapisów: advisory lock na `client_request_id`, potem `inventory_requests` — ten sam użytkownik,
rodzaj i odcisk parametrów → wynik z `idempotent_replay: true`; inaczej `IDEMPOTENCY_CONFLICT`.

### `inventory_approve` — jedna transakcja

1. Rola → walidacja (`count_ids` 1–5000 albo null) → odcisk (sesja + posortowane id / „ALL”).
2. Advisory lock w przestrzeni `forbud.stock_op:` (id = `client_request_id` operacji INVENTORY) → replay z
   `inventory_requests`; id użyte przez inną operację magazynową → `IDEMPOTENCY_CONFLICT`.
3. Sesja `FOR NO KEY UPDATE` (OPEN) — szereguje z zapisem liczeń (`FOR SHARE`), zamknięciem i drugim zatwierdzaniem.
4. Blokady (ADR 010): materiały pozycji `COUNTED` rosnąco `FOR NO KEY UPDATE` → lokalizacje rosnąco `FOR SHARE` →
   wiersze `stock` rosnąco `FOR UPDATE`.
5. Per pozycja (rosnąco po materiale, lokalizacji): zatwierdzona → pominięta (`ALREADY_APPROVED` przy jawnym id);
   RECOUNT → zostaje; znacznik ≠ → RECOUNT; różnica 0 → MATCHED (bez ruchu); w górę dla nieaktywnego materiału /
   lokalizacji → pominięta z powodem; ułamek przy materiale całkowitym → `NOT_INTEGER`; reszta → do ruchu.
6. Gdy są różnice: operacja `INVENTORY` (`user_id` = zatwierdzający, `inventory_session_id`), ruchy (delta ≠ 0), stan:
   UPDATE istniejących, INSERT brakujących (tylko w górę; nie `ON CONFLICT` — ADR 011). `CHECK (quantity >= 0)` —
   ostatnia bariera (różnica = policzono − stan pod blokadą, więc wynik = policzono ≥ 0).
7. Wynik: `operation_id`, `approved[]` (delta, nowy stan), `approved_count`, `matched_count`, `recount[]`, `skipped[]`.

Rezerwacje: bez zmian. Storno operacji INVENTORY: istniejące `stock_reverse` (ADMIN) obsługuje wiele ruchów jednej
operacji — bez zmian funkcji; tabela pokazuje „cofnięta”.

### Kolejność blokad (rozszerza ADR 010/011/014)

`advisory(client_request_id)` → **[inwentaryzacja: sesja]** → materiał(y) → zlecenie → lokalizacje → wiersze `stock` →
rezerwacje. Funkcje stockowe nie blokują sesji; funkcje inwentaryzacji poza zatwierdzaniem nie blokują materiałów;
zapis liczeń: sesja (`FOR SHARE`) → wiersz lokalizacji sesji; tworzenie sesji: globalny advisory (bez blokad wierszy).
Cykl niemożliwy.

### Współbieżność (testy z dwoma połączeniami)

- Zatwierdzanie w toku → wydanie tego materiału czeka na blokadę materiału, potem działa na stanie po inwentaryzacji
  (test: stan 10, policzono 3, wydanie 5 → `INSUFFICIENT_STOCK`, stan 3).
- Wydanie / przyjęcie w toku → zatwierdzanie czeka, po zatwierdzeniu ruchu widzi nową liczbę ruchów → RECOUNT (ruch nie
  zginął, różnica nie nadpisała go).
- Losowa mieszanka (3 rundy: zatwierdzanie + wydania + przyjęcie równolegle): brak błędów poza `INSUFFICIENT_STOCK`,
  każda pozycja APPROVED/MATCHED albo RECOUNT, Σ ruchów = stan, `verify_stock` puste.
- Idempotencja: 5× równolegle ten sam id → jedna operacja (1 wynik nowy + 4 replay); zapis liczenia 5× → jeden zapis.
- Dwie sesje równolegle na tę samą lokalizację → dokładnie jedna powstaje.

## Historia ruchów

`list_stock_movements` (create or replace, ta sama sygnatura; diff względem `20261002120000`: dwa pola
`inventory_session_id`, `inventory_session_name` + `left join inventory_sessions`). „Historia ruchów” ma typ
Inwentaryzacja w filtrze i link „Sesja: …” przy ruchu.

## Sprzątanie testów

`purge_test_stock(p_material_ids, p_order_ids, p_inventory_session_ids)` — nowa sygnatura (DROP + CREATE; wywołania
nazwanymi parametrami bez zmian). Usuwa liczenia i historię liczeń materiałów `is_test` (przed operacjami — FK),
sesje wyłącznie o nazwie `TEST-…` (z lokalizacjami sesji i żądaniami); sesja z liczeniami materiałów spoza danych
testowych albo z operacją INVENTORY spoza materiałów testowych → przerwanie całości. Do usunięcia przed startem (PLAN).

## API

| Endpoint | Role | Odpowiedzi |
|---|---|---|
| `GET /api/v1/inventory/sessions?status=` | wszyscy | lista z postępem |
| `POST /api/v1/inventory/sessions` `{client_request_id, name, note?, location_ids? \| code_prefix? \| all_locations?: true}` | BIURO, ADMIN | 201 / 200 replay / 409 `LOCATION_IN_OPEN_SESSION` (`details.locations`), `IDEMPOTENCY_CONFLICT` / 400 `LOCATION_INACTIVE`, `NO_LOCATIONS` |
| `GET /api/v1/inventory/sessions/[id]` | wszyscy (PRODUKCJA — bez danych systemowych) | 200 / 404 |
| `GET /api/v1/inventory/sessions/[id]/locations/[locationId]` | PRODUKCJA, ADMIN | ekran liczenia / 404 / 409 `LOCATION_NOT_IN_SESSION` |
| `POST .../locations/[locationId]/count` `{client_request_id, started_at, location_version, items[{material_id, quantity}]}` | PRODUKCJA, ADMIN | 201 / 200 / 409 `LOCATION_COUNT_CHANGED`, `SESSION_NOT_OPEN`, `ALREADY_APPROVED`, `COUNT_STALE`, `LOCATION_NOT_IN_SESSION` / 400 `NOT_INTEGER`, `DUPLICATE_MATERIAL` |
| `POST .../approve` `{client_request_id, count_ids?, expected_counts?}` (pominięte z powodem: `COUNT_CHANGED`, `MATERIAL_INACTIVE`, `LOCATION_INACTIVE`, `NOT_INTEGER`, `ALREADY_APPROVED`) | BIURO, ADMIN | 201 / 200 / 409 `SESSION_NOT_OPEN` / 404 |
| `POST .../close` `{client_request_id}`, `POST .../cancel` `{client_request_id, reason?}` | BIURO, ADMIN | 200 / 409 `SESSION_NOT_OPEN`, `SESSION_HAS_APPROVALS` |
| `GET .../export?onlyDiff=true` | BIURO, ADMIN | CSV (BOM, `;`, przecinek) |

CSRF (`parseJsonBody`), zod `.strict()`, rola w route handlerze i ponownie w funkcji DB (42501 → 403).

## UI

- **Desktop** (BIURO, ADMIN) — „Inwentaryzacja” w nawigacji. `/inwentaryzacja`: lista sesji (status, policzone
  lokalizacje X/Y) i formularz nowej sesji (wg prefiksu z podglądem liczby lokalizacji / zaznaczenie z filtrem /
  wszystkie aktywne; ostrzeżenie o lokalizacjach w innej otwartej sesji). `/inwentaryzacja/[id]`: kafle postępu,
  niepoliczone lokalizacje, tabela (lokalizacja, materiał, stan systemowy teraz, policzono, różnica, status z powodem
  blokady / linkiem do operacji / „cofnięta”, liczył), filtry statusu, „Zatwierdź zaznaczone” / „Zatwierdź wszystkie
  do zatwierdzenia” → panel potwierdzenia (lista różnic, ostrzeżenie o nadrezerwacji `overReservationAfterApprove`,
  `useConfirmGuard`), wynik (zatwierdzone, zgodne, pominięte RECOUNT z listą, pominięte z powodem), „Zamknij sesję…”
  (ostrzeżenie: niepoliczone lokalizacje, niezatwierdzone pozycje, niewpisane materiały — nic nie jest zerowane),
  „Anuluj sesję…” (tylko bez zatwierdzeń), CSV różnic / wszystkich pozycji, historia liczeń.
- **Terminal** (PRODUKCJA, ADMIN): kafel INWENTARYZACJA na `/m` (aktywny, gdy jest otwarta sesja; inaczej wyszarzony
  „brak otwartej sesji”) → `/m/inwentaryzacja` (wybór sesji) → `/m/inwentaryzacja/[id]`: postęp, skan lokalizacji
  (spoza sesji → komunikat) albo lista (niepoliczone pierwsze) → lista materiałów oczekiwanych BEZ ilości + „Dodaj inny
  materiał” (wyszukiwarka kartoteki) → duże pola ilości (przecinek, 0 = brak na półce, RECOUNT — puste „policz
  ponownie”, zatwierdzone tylko do odczytu) → „Dalej” → podsumowanie (pozycje, ostrzeżenie o pustych polach:
  niepoliczone / usunięcie wcześniejszego liczenia) → ZAPISZ LOKALIZACJĘ (`useConfirmGuard`) → „Następna lokalizacja”.

Ochrona przed duplikatem (desktop i terminal): `useOperationAttempt` — wynik nieznany (sieć / 5xx / RETRY) albo 401 →
dane zamrożone, „Spróbuj ponownie” wysyła ten sam payload z tym samym id, „Porzuć”; `beforeunload` na terminalu.

## Decyzje własne (implementer)

- Znacznik = liczba ruchów + suma delt sprzed chwili OTWARCIA lokalizacji do liczenia (czas serwera), nie chwili
  zapisu — wykrywa także ruchy w trakcie liczenia półki.
- Zapis lokalizacji = pełny stan: pozycja niezatwierdzona pominięta w nowym zapisie jest usuwana (zdarzenie REMOVE) —
  terminal pokazuje to przed zapisem. Materiał oczekiwany bez wpisu → „niepoliczony” (nie zerujemy).
- Desktop zawsze wysyła jawną listę `count_ids` (pozycje widoczne dla zatwierdzającego) oraz `expected_counts`
  ({count_id: ilość policzona widziana w tabeli}) — migracja `20261005110000`: nowy parametr `p_expected_counts jsonb`
  (domyślnie null, stare wywołania działają; odcisk idempotencji go obejmuje). Pozycja, której liczenie zmieniono po
  wczytaniu tabeli, jest pomijana z powodem `COUNT_CHANGED` (analogia do STOCK_CHANGED) — zatwierdzający odświeża tabelę
  i zatwierdza ponownie. Test DB: liczenie 8 → poprawione na 6 → zatwierdzenie z oczekiwanym 8 = pominięte, stan bez zmian.
- Tworzenie sesji tylko z aktywnych lokalizacji. Anulowanie tylko bez zatwierdzeń.
- RECOUNT na ekranie liczenia: pole puste (bez podpowiedzi poprzedniej wartości), żeby nie sugerować wyniku.
- Niepotwierdzony zapis liczenia nie jest trzymany w `sessionStorage` (jak przyjęcia) — tylko w pamięci ekranu:
  powtórzony zapis jest nieszkodliwy (nadpisanie tą samą wartością), a liczenie nie jest ruchem magazynowym.

## Ograniczenia

- Różnica pozycji RECOUNT jest w tabeli ukryta („—”), ale w CSV podana informacyjnie (policzono − stan teraz).
- API wywołane bez `expected_counts` (inny klient) zatwierdza aktualne liczenie — kontrolę COUNT_CHANGED wysyła desktop.
- Lista lokalizacji w formularzu nowej sesji pobiera do 1000 aktywnych lokalizacji (limit Data API); tryb
  „wszystkie” i „prefiks” rozstrzyga baza bez limitu.
- `inventory_session_review` liczy `count(*)` ruchów per pozycja (indeks `(material_id, created_at)`) — przy skali
  FOR-BUD (setki pozycji na sesję) milisekundy.
- Worker: +76 KiB gzip (1897,1 KiB / 2560; przed etapem 1821,3 KiB).

## Poprawki po review (migracja `20261005120000_inventory_review_fixes.sql`)

- **HIGH-1 — dwóch liczących na tej samej lokalizacji.** `inventory_session_locations.count_version` (licznik zapisów
  lokalizacji). `inventory_counting_location` zwraca `location_version`; terminal odsyła ją (`location_version`, zod —
  wymagana), a `inventory_save_location_count(…, p_expected_version)` pod blokadą wiersza lokalizacji sesji (`FOR UPDATE`)
  odrzuca zapis, gdy wersja się zmieniła → `LOCATION_COUNT_CHANGED` (409). Replay (ten sam id) jest sprawdzany przed
  wersją — powtórzenie już zapisanego żądania nadal zwraca wynik. Terminal: „Ktoś zapisał tę lokalizację w międzyczasie —
  otwórz ją ponownie” + „Otwórz lokalizację ponownie”.
  **Wybrany wariant dla przeniesionych wartości:** baza NIE nadpisuje pozycji `COUNTED` z tą samą ilością i bez ruchu od
  znacznika (autor, czas liczenia i znacznik zostają; wynik `unchanged`). Ekran nadal pokazuje zapisane liczenia (żeby
  ponowny zapis lokalizacji ich nie usuwał). Po ruchu (RECOUNT na żywo) pole jest puste, a ta sama ilość wpisana ponownie
  to nowe liczenie — odświeża znacznik. Dzięki temu przeniesiona cudza wartość nie „ukrywa” ruchu nowym znacznikiem.
  Testy DB: (a) zapis B ze starą wersją nie usuwa liczenia A; (b) stary ekran A nie nadpisuje korekty B + replay; autor
  i znacznik przeniesionej pozycji bez zmian.
- **MEDIUM-1:** w teście losowej mieszanki dla każdej pozycji APPROVED: liczba ruchów sprzed rozpoczęcia liczenia =
  znacznik, a Σ tych ruchów + delta INVENTORY = policzono. Nie sumujemy „prefiksu po `created_at`”, bo `created_at`
  (początek transakcji) nie odpowiada kolejności zatwierdzeń transakcji czekających na blokadę materiału.
- **MEDIUM-2:** testy: przesunięcie tam i z powrotem (stan bez zmian) → RECOUNT; ruch innego materiału w lokalizacji →
  pozycja DIFF i zatwierdzalna; zatwierdzanie w toku vs `stock_transfer` / `stock_adjust` (STOCK_CHANGED) /
  `stock_reverse` (INSUFFICIENT_STOCK) i odwrotnie (operacja w toku → RECOUNT); skrócony stres (4 rundy `Promise.all`:
  dwa zatwierdzania, przesunięcia w obie strony, wydanie, przyjęcie, korekta, zapis liczenia, storno INVENTORY z
  poprzedniej rundy) — brak 40P01 i błędów spoza domeny, stan ≥ 0, `verify_stock` puste.
- **LOW-1 — storno INVENTORY w otwartej sesji:** `stock_reverse` bez zmian. Pozycje cofniętej operacji zostają
  `APPROVED` (liczenie nie wraca do zatwierdzania, nie można go zmienić — `ALREADY_APPROVED`). Tabela pokazuje przy
  pozycji „cofnięta — aby policzyć ponownie, zamknij sesję i utwórz nową”.
- **LOW-2:** `p_started_at` z przyszłości ponad 5 s → `VALIDATION` (było 5 min).
- **LOW-4:** terminal — przy `ALREADY_APPROVED`, `LOCATION_COUNT_CHANGED` i `COUNT_STALE` przycisk „Otwórz lokalizację
  ponownie” (świeże dane, nowa wersja i znacznik).
- LOW-3, LOW-6 — bez zmian (decyzja Tech Leada).
- LOW-5 — bez zmian: formularz nowej sesji w trybie prefiksu liczy podgląd po stronie klienta z maks. 1000 lokalizacji (limit Data API); przy > 1000 lokalizacji podgląd może pokazać 0 i zablokować wysłanie, choć baza by je znalazła. Przy skali FOR-BUD nierealne — do poprawy (podgląd liczony w SQL), gdy liczba lokalizacji zbliży się do 1000.

## Postęp

- [x] Migracja (ROLLBACK z próbą funkcjonalną → `db:push`, wgrana)
- [x] Serwer/API (`src/server/inventory.ts`, `src/lib/validation/inventory.ts`, `src/app/api/v1/inventory/**`)
- [x] UI desktop (`/inwentaryzacja`, `/inwentaryzacja/[id]`, nawigacja, historia ruchów z nazwą sesji)
- [x] Terminal (kafel na `/m`, `/m/inwentaryzacja`, `/m/inwentaryzacja/[id]`)
- [x] Poprawka COUNT_CHANGED (migracja `20261005110000`: ROLLBACK z próbą → `db:push`, wgrana; serwer, desktop)
- [x] Testy DB `tests/db/inventory.test.ts` (26 → 37 po review), unit `tests/unit/inventory.test.ts` (72 → 75)
- [x] Weryfikacja: lint, typecheck, test 799/799, test:db 369/369 (12 plików), build, cf:build, check:size 1897,1 KiB,
  check:secrets, db:migrations
- [x] Smoke na `wrangler dev` (konta test-smk-* kluczem secret, posprzątane): bez sesji 401 / 415 / 403 CSRF; desktop
  BIURO — sesja wg prefiksu (`test-smk-a-` → 2 lokalizacje), tabela, zatwierdzenie wszystkich (3 różnice, 1 RECOUNT po
  wydaniu w tle), historia z nazwą sesji, CSV różnic, zamknięcie z ostrzeżeniem; terminal 375 px PRODUKCJA — kafel
  aktywny, lokalizacja spoza sesji odrzucona, liczenie na ślepo (bez ilości w UI i API), dodanie innego materiału, 0,
  PRODUKCJA → approve 403
- [x] Poprawki po review: migracja `20261005120000` (ROLLBACK z próbą → `db:push`, wgrana), serwer/API, terminal, desktop, testy
- [x] Weryfikacja po review: lint, typecheck, test 802/802, test:db 380/380 (12 plików), build, cf:build, check:size 1898,3 KiB, check:secrets, db:migrations; smoke: dwóch liczących na jednej lokalizacji — drugi zapis przez API → 409 `LOCATION_COUNT_CHANGED`, terminal pokazuje komunikat i „Otwórz lokalizację ponownie”
