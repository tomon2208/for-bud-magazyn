# ADR 013 — Zlecenia (numer, W produkcji), zapotrzebowanie ręczne i braki (Etap 8–10)

Migracja: `supabase/migrations/20261003100000_orders_requirements_shortages.sql`. Rozwija ADR 010 (zlecenia), 012 (CSV). Bez rezerwacji (Etap 11) i importu LiczOkno (Etap 12) — model je przewiduje.

## Decyzje użytkownika (2026-10-02)

1. **Zlecenie**: status `IN_PRODUCTION` („W produkcji”): Otwarte → W produkcji → Zakończone/Anulowane (ponowne otwarcie dozwolone). **Wydanie dozwolone dla OPEN i IN_PRODUCTION** (`stock_issue`: zmieniony wyłącznie warunek statusu i treść komunikatu `ORDER_NOT_OPEN` — „Zlecenie jest zakończone lub anulowane”). Opcjonalny **numer** (`number text null`, ≤ 50, trim, pusty → NULL; unikalny bez względu na wielkość liter: `unique index (lower(number)) where number is not null`; duplikat → 23505 → API 409 `NUMBER_TAKEN`). Numer jest w `orderSubLabel` („nr Z-1 · utw. …”), kolumnie list, pickerach i podsumowaniach; wyszukiwanie po nazwie i numerze. Historia ruchów nadal pokazuje samą nazwę (patrz ograniczenia).
2. **Zapotrzebowanie: wiele list na zlecenie, sumowane.** `requirements` (zlecenie, `source` MANUAL/IMPORT, nazwa ≤ 120, `imported_file_name`, `import_format`, status ACTIVE/WITHDRAWN, `withdrawn_at/by`, `withdraw_reason` 3–200, `client_request_id` unikalny, audyt) i `requirement_items` (lista, materiał, `quantity numeric(12,3)` 0 < q ≤ 1 000 000, `note` ≤ 200, `raw_source_ref` na import; `unique (requirement_id, material_id)`). Lista **niezmienna**: pozycje bez UPDATE/DELETE (trigger `IMMUTABLE`, brak GRANT-ów), lista zmienia się tylko przez przejście ACTIVE → WITHDRAWN (trigger `requirements_a_guard` pilnuje, że reszta kolumn jest bez zmian). Poprawka = „Wycofaj” (z powodem) + „Utwórz poprawioną kopię” (formularz wypełniony pozycjami wycofanej listy). Zapotrzebowanie zlecenia = suma pozycji list ACTIVE.
   - Zapis wyłącznie funkcjami `create_requirement(order, name, items jsonb, client_request_id?)` i `withdraw_requirement(id, reason)` (SECURITY DEFINER, rola BIURO/ADMIN → inaczej 42501, `search_path=''`). Role aplikacyjne mają tylko SELECT; `service_role` SELECT + DELETE (sprzątanie testów). Czytają wszyscy aktywni.
   - `create_requirement`: 1–500 pozycji, materiał raz (`DUPLICATE_MATERIAL`), ilość (`INVALID_QUANTITY`), ułamki wg `allows_fraction` (`NOT_INTEGER`, detail = kod materiału; trigger pozycji jako ostatnia bariera), materiał aktywny (`MATERIAL_INACTIVE`), zlecenie OPEN/IN_PRODUCTION (`ORDER_NOT_OPEN`; zlecenie `FOR SHARE` — zamknięcie zlecenia w trakcie tworzenia listy czeka). Idempotencja po `client_request_id` (advisory lock; ten sam użytkownik i zlecenie → replay 200, inaczej `IDEMPOTENCY_CONFLICT`). Jedna transakcja.
3. **Braki** (bez rezerwacji):
   - per zlecenie i materiał: `potrzebne` = Σ ACTIVE; `wydano` = netto (ISSUE + REVERSAL zlecenia, jak `order_issue_summary`); `pozostało` = max(potrzebne − wydano, 0); `dostępne` = stan łączny w AKTYWNYCH lokalizacjach; `brakuje` = max(pozostało − dostępne, 0).
   - zbiorczo: per materiał Σ `pozostało` po zleceniach OPEN + IN_PRODUCTION, `dostępne` liczone **raz**, `brakuje` = max(Σ pozostało − dostępne, 0); lista zleceń (numer, nazwa, pozostało); sortowanie dostawca (bez dostawcy na końcu) → największy brak; filtry dostawca / kategoria / tylko z brakiem. Przykład z testów: dwa zlecenia po 8, stan 10 → brakuje 6 (nie 0).
   - **Etap 11 (rezerwacje)** — jedno miejsce zmiany: `app.shortage_available` (dostępne → stan − aktywne rezerwacje innych zleceń; per zlecenie + własna rezerwacja). `app.requirement_balance` (potrzebne/wydano/pozostało) zostaje.

## Funkcje SQL

| Funkcja | Rola | Opis |
|---|---|---|
| `app.requirement_balance(uuid[])` | wewnętrzna | potrzebne/wydano/pozostało per (zlecenie, materiał); `NULL` = wszystkie OPEN + IN_PRODUCTION |
| `app.shortage_available(uuid[])` | wewnętrzna | dostępne (aktywne lokalizacje) |
| `app.shortage_rows(supplier, category, only_short)` | wewnętrzna | agregat zbiorczy z listą zleceń (jsonb) |
| `shortages_summary(...)` | ADMIN, BIURO | wiersze strony „Braki” (limit 2000, `total_rows`) |
| `shortage_material_count()` | ADMIN, BIURO | kafel dashboardu |
| `order_shortages(order)` | ADMIN, BIURO | sekcja „Braki zlecenia” (wiersze z brakiem pierwsze) |
| `order_overview(order_ids[])` | ADMIN, BIURO | liczba list ACTIVE + flaga „są braki” (wzór per zlecenie) dla `/zlecenia` (≤ 200 id) |
| `order_to_issue(order)` | każda aktywna rola | „Do wydania na to zlecenie” (pozostało > 0, dostępne łącznie) |
| `export_shortages_csv(...)` | ADMIN, BIURO | CSV w SQL (`app.csv_*`), limit 20 000 wierszy → `TOO_MANY_ROWS` |

**Odstępstwo od „SECURITY INVOKER”:** funkcje braków są SECURITY DEFINER z jawną kontrolą roli i pustym `search_path`. Powód: z RLS PRODUKCJA widzi tylko własne ruchy, a „wydano netto” musi uwzględniać wszystkich użytkowników (terminal pokazuje „Do wydania”); funkcje pomocnicze `app.*` nie są dostępne dla ról aplikacyjnych. Wszystko liczy baza — Worker tylko mapuje wyniki (budżet CPU).

CSV braków: te same helpery co eksport stanów (średnik, przecinek dziesiętny, BOM dokleja route handler, neutralizacja formuł, kody `="KOD"`); kolumny: Dostawca (brak → „brak dostawcy”), Kod, Nazwa, Kategoria, Jednostka, Pozostało do wydania, Dostępne, Brakuje, Zlecenia (`numer nazwa (pozostało)`).

## API

`GET/POST/PATCH /orders` (number, `IN_PRODUCTION`, filtr `status=ISSUABLE` = Otwarte + W produkcji, `q` po nazwie/numerze), `GET/POST /orders/[id]/requirements` (POST: BIURO/ADMIN, `.strict()`, `client_request_id` opcjonalny, 201/200 replay), `POST /requirements/[id]/withdraw` (`{reason}`), `GET /orders/[id]/shortages` (BIURO/ADMIN), `GET /orders/[id]/to-issue` (PRODUKCJA/ADMIN), `GET /shortages?supplier=&category=&onlyShort=`, `GET /shortages/export`. Błędy: `NUMBER_TAKEN` 409, `ORDER_NOT_OPEN` 409, `ALREADY_WITHDRAWN` 409, `DUPLICATE_MATERIAL`/`NOT_INTEGER`/`MATERIAL_INACTIVE`/`INVALID_QUANTITY` 400.

## UI

- `/zlecenia`: numer, nazwa, status, data, liczba list, „są braki”; filtr statusu (domyślnie Otwarte + W produkcji; `?status=ALL`), przyciski zmiany statusu z potwierdzeniem przy zamykaniu.
- `/zlecenia/[id]`: edycja nazwy/numeru/notatki i status, **Zapotrzebowanie** (listy ACTIVE, wycofane zwinięte, formularz wielowierszowy: wyszukaj → ilość → dodaj; ten sam materiał wpisany drugi raz jest sumowany; po wycofaniu otwiera się poprawiona kopia), **Braki zlecenia** z uwagą, że „Dostępne” jest wspólne, wydania.
- `/braki` (nawigacja „Braki”): zbiorczo, grupy wg dostawcy, filtry, „Pobierz CSV”; kafel „Materiały z brakiem do zleceń” na dashboardzie.
- Terminal: lista zleceń = OPEN + IN_PRODUCTION (badge „W produkcji”, numer); w kroku materiału sekcja „Do wydania na to zlecenie” (odświeżana po każdym wydaniu), tapnięcie wybiera materiał i podpowiada ilość = min(pozostało, dostępne w wybranej lokalizacji); zwykłe wyszukiwanie zostaje.

## Decyzje własne

- Lista można dodać tylko do zlecenia OPEN/IN_PRODUCTION (do zamkniętego — najpierw otworzyć); wycofać można zawsze.
- Materiał nieaktywny nie wchodzi na listę.
- `client_request_id` na listach (nie było w specyfikacji) — chroni przed podwójnym zapisem sumowanego zapotrzebowania.
- Filtr API `onlyShort` domyślnie `false`; strona `/braki` domyślnie pokazuje tylko braki (`?braki=0` — wszystkie).
- Flaga „są braki” na liście zleceń używa wzoru per zlecenie (zgodnie z sekcją Braki zlecenia).

## Ograniczenia

- Historia ruchów pokazuje samą nazwę zlecenia (bez numeru) — wymagałoby zmiany `list_stock_movements`.
- Brak edycji notatki pozycji w UI (pole `note` jest w API i bazie).
- Brak rezerwacji: „dostępne” jest wspólne dla zleceń; prawdziwe braki do zamówienia daje strona „Braki”.
- Zlecenia DONE/CANCELLED nie wchodzą do braków zbiorczych; wycofane listy nie liczą się nigdzie.

## Poprawki po review (migracja `20261003110000_requirements_review_fixes.sql`)

- **M1 — idempotencja list:** `requirements.request_hash` = md5(nazwa, zlecenie, pozycje `material|ilość bez zer końcowych|notatka`, posortowane po materiale), liczony w `create_requirement` (walidacja struktury przed sprawdzeniem replay). Powtórzenie z tym samym `client_request_id` zwraca istniejącą listę tylko przy tym samym użytkowniku i tym samym odcisku; inaczej `IDEMPOTENCY_CONFLICT` (409). UI: identyfikator żądania jest ten sam przy ponowieniu IDENTYCZNEJ listy (po błędzie sieci) i nowy po jej zmianie; komunikat sukcesu pokazuje `item_count` z serwera.
- **M3 — terminal:** każde wejście w krok wyboru materiału unieważnia stary wynik „Do wydania” (stan „wczytywanie” do nowej odpowiedzi); podpowiedź ilości liczy czysta funkcja `suggestIssueQuantity` (`src/lib/to-issue.ts`) wyłącznie ze świeżych danych.
- **M4 / L3 (UI):** „Zapisz listę” jest blokowane, gdy wybrany materiał ma wpisaną ilość, a nie został dodany; wycofanie listy przy otwartym formularzu z wierszami pyta o zastąpienie go poprawioną kopią.
- **L1 — wydajność:** `app.requirement_balance` i `app.shortage_rows` agregują per (zlecenie, materiał) w CTE `MATERIALIZED` przed joinami; `order_shortages` / `order_to_issue` / `order_overview` liczą bilans raz. Pomiar w transakcji z ROLLBACK, bez `ANALYZE` (400 zleceń, 5600 pozycji, ~3200 operacji): `shortage_rows` ≈ 150 ms, `requirement_balance(NULL)` ≈ 100 ms (poprzednia wersja ≈ 150 / 85 ms w tym syntetycznym teście — plan jest teraz niezależny od statystyk). **Etap 12:** po masowym imporcie zapotrzebowania wykonać `ANALYZE requirements, requirement_items`.
- **L2:** „brakuje” (`order_shortages`) i `has_shortage` (`order_overview`) tylko dla zleceń OPEN / IN_PRODUCTION; dla zamkniętych 0 / false.
- **L4:** `array_remove(p_order_ids, null)` w `requirement_balance` i `order_overview`.
- **L5 / M2 (testy):** materiał dezaktywowany po utworzeniu listy nadal liczy się do braków; test nieaktywnej lokalizacji omija trigger wyłącznie w transakcji kończonej wymuszonym ROLLBACK (nic nie jest zatwierdzane na współdzielonej bazie).
