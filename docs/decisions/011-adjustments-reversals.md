# ADR 011 — Korekty, cofanie operacji (storno) i historia ruchów (Etap 6)

Migracja: `supabase/migrations/20261002120000_adjustments_reversals.sql`. Rozwija ADR 002 (ledger), 004 (korekty), 009, 010.

## Decyzje użytkownika (2026-10-02)

1. **Korekta = „ustaw stan na X”** (tylko ADMIN). System liczy różnicę i zapisuje operację `ADJUSTMENT` z jednym ruchem.
2. **„Cofnij ten ruch” (storno)** z historii, tylko ADMIN: nowa operacja `REVERSAL` z ruchami odwrotnymi, oryginał
   oznaczony jako cofnięty (z joinu — operacje są niemutowalne).
3. **Historia ruchów** `/historia` (ADMIN, BIURO), filtry w URL, filtrowanie i paginacja w SQL.

## Model

- `stock_operations.type` += `REVERSAL`.
- `stock_operations.reverses_operation_id uuid` → FK `stock_operations(id)`, **UNIQUE** (operację cofa się raz).
  CHECK `stock_operations_reversal_link`: `REVERSAL ⇔ reverses_operation_id is not null`; CHECK
  `stock_operations_reversal_reason`: storno ma opis ≥ 3 znaki. Niemutowalność (trigger) obejmuje też nową kolumnę.
- **Kody powodów per typ** (`stock_operations_reason_code_valid`): wydanie — `SERWIS, USZKODZENIE, ZUZYCIE_WLASNE,
  PROBKA, INNY`; korekta — `POMYLKA_PRZYJECIA, POMYLKA_WYDANIA, USZKODZENIE, ZAGINIECIE, ZNALEZIONE, STAN_POCZATKOWY,
  INNY`; inne typy — brak kodu. `stock_operations_adjustment_reason`: korekta zawsze ma kod. INNY ⇒ opis (bez zmian).
- Indeksy pod historię: `stock_movements (user_id, created_at desc)`, `stock_movements (created_at desc, id desc)`
  (materiał, lokalizacja, zlecenie — już były).

## `public.stock_adjust(client_request_id, material_id, location_id, target_quantity, expected_current, reason_code, reason?, note?)`

Kolejność: rola ADMIN (inaczej 42501) → idempotencja (advisory lock; porównanie: użytkownik, typ, materiał,
lokalizacja, **różnica `target − expected`**, kod, opis, notatka) → walidacja (kod z listy korekt, INNY ⇒ opis
`REASON_REQUIRED`, opis ≤ 200, target 0…1 000 000 skala 3, expected ≥ 0) → blokady (materiał `FOR NO KEY UPDATE`,
lokalizacja `FOR SHARE`, wiersz stanu `FOR UPDATE`) → całkowitość (`NOT_INTEGER`) → **`stan ≠ expected` →
`STOCK_CHANGED` (detail = aktualny stan)** → różnica 0 → `NO_CHANGE` (nic nie zapisujemy) → nieaktywny materiał /
lokalizacja i różnica > 0 → `MATERIAL_INACTIVE` / `LOCATION_INACTIVE` (w dół dozwolone — wyzerowanie przed
dezaktywacją) → zapis (operacja + 1 ruch + upsert stanu; korekta z 0 tworzy wiersz stanu).

Kolejność kontroli STOCK_CHANGED przed NO_CHANGE jest celowa: ADMIN widział 5, wpisał 3, a w międzyczasie ktoś wydał 2
(stan 3) — to nie „stan się zgadza”, tylko zmiana, którą ADMIN musi zobaczyć.

Replay zwraca `previous_quantity = expected` i **bieżący** stan (jak inne funkcje).

## `public.stock_reverse(client_request_id, operation_id, reason, note?)`

Kolejność: rola ADMIN → idempotencja (użytkownik, typ, cofana operacja, powód, notatka) → walidacja (powód ≥ 3 / ≤ 200
znaków) → **oryginał `FOR NO KEY UPDATE`** (serializuje równoległe próby cofnięcia tej samej operacji; nie koliduje z
`FOR KEY SHARE` sprawdzeń FK) → `REVERSAL` → `NOT_REVERSIBLE`; już cofnięta → `ALREADY_REVERSED` → blokady: materiały
(rosnąco po id), lokalizacje `FOR SHARE` (rosnąco), wiersze stanu `FOR UPDATE` (rosnąco po material_id, location_id) →
kontrola per (materiał, lokalizacja): zwiększenie stanu nieaktywnego materiału/lokalizacji → `MATERIAL_INACTIVE` /
`LOCATION_INACTIVE` (detail = kod lokalizacji); spadek < 0 → `INSUFFICIENT_STOCK` (detail = JSON `{available,
location_code}`) → zapis: operacja `REVERSAL` (**`production_order_id` skopiowane z oryginału**), ruchy odwrotne do
wszystkich ruchów oryginału (przesunięcie → 2), aktualizacja stanów.

- Stany: UPDATE istniejących wierszy, INSERT brakujących (tylko zwiększenia). Nie `INSERT … ON CONFLICT`, bo
  CHECK `quantity >= 0` sprawdza proponowany wiersz (ujemną deltę) przed rozstrzygnięciem konfliktu — wykryte w teście
  migracji z ROLLBACK.
- Storno storna niedozwolone (decyzja użytkownika). Po cofnięciu oryginału można go „ponowić” tylko nową operacją.
- **Decyzja implementera:** storno wydania na zamknięte (DONE/CANCELLED) zlecenie jest dozwolone — to korekta historii,
  nie nowe wydanie; zlecenie nie jest blokowane `FOR SHARE` (FK i tak bierze `FOR KEY SHARE`).
- `UNIQUE(reverses_operation_id)` jako ostatnia bariera: `23505` z tą nazwą → API `409 ALREADY_REVERSED`.

### Kolejność blokad (rozszerza ADR 010)

`advisory(client_request_id)` → [storno: oryginalna operacja] → materiał(y) → zlecenie → lokalizacje → wiersze `stock`
→ dostawca. Wiersza operacji nie blokuje żadna inna funkcja, więc nowy krok nie tworzy cyklu.

## Podsumowanie zlecenia

`order_issue_summary(order_id)` sumuje operacje `ISSUE` i `REVERSAL` zlecenia: `quantity` = wydano netto, `issues`,
`reversals` (nowa kolumna; funkcja odtworzona). Szczegóły zlecenia, „Wydania”, „Przyjęcia” pokazują „cofnięto” z linkiem
do historii.

## Historia: `list_stock_movements` (nowa sygnatura, stare wywołania działają)

Nowe parametry: `p_material_id`, `p_location_id`, `p_user_id`, `p_operation_id` (operacja **albo** jej storno), typ
`REVERSAL`. Przy `p_collapse_transfers` przesunięcie i storno przesunięcia to jeden wiersz (ruch przychodzący, „skąd →
dokąd”), a filtr lokalizacji obejmuje obie strony. Nowe pola: `reverses_*` (co cofa), `reversed_*` (kto/kiedy/powód
cofnął — join, nie UPDATE), `reversible`. PRODUKCJA — nadal tylko własne ruchy (także informacja, że jej operacja została
cofnięta). Jedno zapytanie: CTE z filtrami → `count(*)` + strona `limit/offset` → join szczegółów tylko dla strony.

`public.list_user_names()` (ADMIN, BIURO; SECURITY DEFINER — BIURO widzi w `profiles` tylko siebie) — id, imię i
nazwisko, aktywność do filtra „Użytkownik”.

## API

| Endpoint | Role | Odpowiedzi |
|---|---|---|
| `POST /api/v1/stock/adjustments` | ADMIN | 201 / 200 replay / 409 `STOCK_CHANGED` (`details.current`), `NO_CHANGE`, `IDEMPOTENCY_CONFLICT` / 400 |
| `POST /api/v1/stock/reversals` | ADMIN | 201 / 200 replay / 409 `ALREADY_REVERSED`, `NOT_REVERSIBLE`, `INSUFFICIENT_STOCK` (`details.available`, `details.locationCode`) / 404 / 400 |
| `GET /api/v1/stock/movements?type&q&materialId&locationId&userId&orderId&operationId&from&to&page&pageSize` | wszyscy (PRODUKCJA — własne, wymusza baza) | 200 / 400 |
| `GET /api/v1/stock/verify` | ADMIN | 200 `{checkedAt, discrepancies[]}` |

CSRF, zod `.strict()`, role w route handlerze i ponownie w funkcji DB (42501 → 403).

## UI

- **Desktop „Korekta stanu”** `/magazyn/korekta` (ADMIN; BIURO przekierowane): wejście z „Magazynu” (link „Koryguj” przy
  wierszu: `?material=&lokalizacja=`) albo wybór materiału (także nieaktywnego) i kodu lokalizacji (także tam, gdzie
  materiału nie ma: 0 → X). Aktualny stan, „Faktyczna ilość”, różnica na żywo (`src/lib/adjustment.ts`, testy
  jednostkowe), powód z listy + opis, panel potwierdzenia. STOCK_CHANGED → pokazany nowy stan, ponowne potwierdzenie.
  Ochrona przed duplikatem: `useOperationAttempt` (wynik nieznany → dane zamrożone, „Ponów (ten sam id)” / „Porzuć”).
- **Desktop „Historia ruchów”** `/historia` (ADMIN, BIURO): filtry typ, materiał (fraza; `?material=<id>` z innych
  ekranów), kod lokalizacji, użytkownik, zlecenie (wyszukiwarka), daty; `?operacja=<id>` — operacja z jej stornem;
  paginacja. ADMIN: „Cofnij” przy operacjach, które można cofnąć → panel z opisem skutku, powód, potwierdzenie; panel
  „Sprawdź spójność stanów” (`verify_stock`).
- **Terminal** (ADMIN): na ekranie lokalizacji przy każdym wierszu zawartości „Koryguj” → `/m/korekta` (duże pole ilości,
  różnica na żywo, powody jako duże przyciski, ZATWIERDŹ). PRODUKCJA nie widzi przycisku, strona przekierowuje na `/m`,
  API → 403. „Moje ostatnie operacje” pokazują też korekty.

## Ograniczenia

- Niepotwierdzona korekta/storno nie jest zapisywana w `sessionStorage` (jak przyjęcia/wydania na terminalu) — tylko w
  pamięci formularza; po odświeżeniu strony ADMIN sprawdza wynik w historii. Uzasadnienie: operacje wyłącznie ADMIN-a,
  rzadkie, wykonywane świadomie; replay tym samym id i tak jest bezpieczny.
- `previous_quantity` przy replay korekty = stan widziany przez ADMIN-a, nie historyczny.
- `verify_stock()` bez parametru — pełny skan (akceptowalne przy skali FOR-BUD, ADR 009 L8).
- `purge_test_stock` usuwa operacje jednym `DELETE` — samoodwołujący się FK (`NO ACTION`) sprawdzany na końcu instrukcji,
  więc storna i oryginały znikają razem (test DB). Przed startem produkcyjnym funkcję usuwamy (PLAN, checklista).

## Poprawki po review (migracja `20261002130000_stage6_review_fixes.sql`)

- **M1 — dwuklik w potwierdzeniu:** „Tak, cofnij operację” jest w osobnym bloku (nie w miejscu „Dalej — potwierdź”), a
  `src/lib/confirm-guard.ts` (`useConfirmGuard`) ignoruje kliknięcie potwierdzenia, gdy `event.detail > 1` albo minęło
  < 400 ms od wejścia w potwierdzenie (klawiatura: `detail = 0` — działa). Ten sam guard: korekta desktop i terminal oraz
  ZATWIERDŹ w kreatorach terminala (przyjęcie, wydanie, przesunięcie — przycisk pojawia się w miejscu „Dalej”). Pozostałe
  potwierdzenia (zlecenia, dezaktywacje, użytkownicy) używają modalnego `window.confirm` — dwuklik ich nie omija.
- **L1 — idempotencja korekty:** `stock_operations.adjust_expected numeric(12,3)` (CHECK: wymagana i ≥ 0 dla ADJUSTMENT,
  NULL dla innych; przed wgraniem w bazie nie było operacji ADJUSTMENT). `stock_adjust` zapisuje stan widziany przez
  ADMIN-a i przy replayu porównuje go osobno od różnicy — ten sam id z (5, 0) i (105, 100) → `IDEMPOTENCY_CONFLICT`.
  Replay zwraca `previous_quantity` z zapisanej wartości.
- **L3:** opis skutku cofnięcia przez `endSentence` (bez „szt..”).
- **L4:** „Moje ostatnie operacje” na terminalu oznaczają cofnięte operacje. `public.reversed_operation_ids(uuid[])`
  (SECURITY DEFINER, maks. 200 id): zwraca tylko id operacji widocznych dla wywołującego (PRODUKCJA — własne), bo storno
  ADMIN-a jest dla PRODUKCJI niewidoczne przez RLS.
- **L5 — testy DB:** storno przesunięcia vs równoległe wydanie z lokalizacji docelowej (obie kolejności, dwa połączenia),
  storno z `MATERIAL_INACTIVE`, PRODUKCJA z `p_operation_id` cudzej operacji → 0 wierszy, `%`/`_` w frazie dosłownie,
  granica dnia 23:30 / 00:30 Europe/Warsaw, storno wydania bez zlecenia (z kodem powodu).

## Na później (L2 z review)

- Historia bez filtrów liczy `count(*)` po całym ledgerze przy każdym wejściu. Przy obecnej skali (setki–tysiące ruchów)
  to milisekundy. Gdy historia urośnie (dziesiątki tysięcy ruchów): domyślny zakres dat (np. ostatnie 30 dni, gdy brak
  innych filtrów) i/lub `count` z limitem („ponad 10 000”) zamiast dokładnej liczby; ewentualnie paginacja kursorem
  (`created_at, id`) zamiast `offset`.
