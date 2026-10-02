# ADR 014 — Rezerwacje materiału dla zleceń (Etap 11)

Migracja: `supabase/migrations/20261004100000_reservations.sql` (wgrana). Rozwija ADR 010 (wydania, kolejność blokad),
011 (storno), 012 (widoki stanów), 013 (braki).

## Decyzje użytkownika (2026-10-02)

1. Rezerwacja **globalna per materiał** (bez lokalizacji) i **per zlecenie**; tworzy ją BIURO/ADMIN przyciskiem
   „Zarezerwuj” (domyślnie min(pozostało do zarezerwowania, wolne); możliwa ręczna ilość per pozycja). Tylko materiały
   z zapotrzebowania zlecenia OPEN/IN_PRODUCTION. Pozostało do zarezerwowania = potrzebne − wydano netto − zarezerwowane.
2. **Wolne** = stan w AKTYWNYCH lokalizacjach − Σ aktywnych rezerwacji wszystkich zleceń (min. 0).
3. Wydanie na zlecenie: ≤ wolne + własna rezerwacja; zużywa NAJPIERW własną rezerwację. Wydanie na inne zlecenie /
   bez zlecenia: ≤ wolne, inaczej `RESERVED_STOCK`. ADMIN może wydać mimo rezerwacji (override + powód).
4. Zwalnianie: automatycznie przy DONE/CANCELLED (ta sama transakcja), ręcznie BIURO/ADMIN (całość/część, powód
   opcjonalny). Ponowne otwarcie nie przywraca.
5. Przesunięcie nie wpływa na rezerwacje. Korekta w dół / storno mogą dać Σ rezerwacji > stan — bez automatycznych
   zmian; ostrzeżenie „rezerwacje przekraczają stan”.

## Model

| Tabela | Opis |
|---|---|
| `reservations` | (zlecenie, materiał) UNIQUE, `quantity ≥ 0` (aktualnie zarezerwowane; 0 = zwolniona/zużyta, wiersz zostaje), `last_reserved_at` (LIFO), audyt |
| `reservation_events` | append-only: `RESERVE` (+), `RELEASE`, `CONSUME`, `OVERRIDE`, `AUTO_RELEASE` (−), `quantity_after`, `operation_id` (CONSUME/OVERRIDE), `request_id` (RESERVE/RELEASE; FK odroczony), `reason` (OVERRIDE wymagany), `user_id` (NULL tylko AUTO_RELEASE poza sesją) — CHECK-i spójności typów |
| `reservation_requests` | idempotencja reserve/release: id = `client_request_id`, rodzaj, zlecenie, użytkownik, `request_hash` (md5 parametrów), `result` jsonb zwracany przy replay |
| `stock_operations` + `override_reservations`, `override_reason` | CHECK: override tylko dla ISSUE, powód 3–200 |

**Ochrona zapisu**: role aplikacyjne i `service_role` mają tylko SELECT; trigger `app.reservation_guard_write` przepuszcza
INSERT/UPDATE `reservations` i INSERT historii/żądań tylko przy transakcyjnej fladze `forbud.reservation_write` (ustawianej
przez funkcje); UPDATE/DELETE historii i żądań → `IMMUTABLE` (także dla właściciela bazy); TRUNCATE zabroniony; wyjątek
DELETE tylko przy `forbud.purge_test` + sesja `service_role` + materiał `is_test`. RLS: SELECT dla aktywnych
(`reservation_requests` — ADMIN/BIURO).

## Funkcje (SECURITY DEFINER, `search_path=''`)

- `reserve_for_order(client_request_id, order_id, items jsonb = null)` — BIURO/ADMIN (inaczej 42501). Walidacja pozycji
  (1–500, materiał raz `DUPLICATE_MATERIAL`, ilość `INVALID_QUANTITY`) → odcisk → advisory lock + replay
  (inny użytkownik/rodzaj/odcisk → `IDEMPOTENCY_CONFLICT`) → zbiór materiałów (ręcznie: z pozycji; auto: z list ACTIVE)
  → **blokady: materiały rosnąco `FOR NO KEY UPDATE` → zlecenie `FOR SHARE` → wiersze rezerwacji zlecenia** → status
  (`ORDER_NOT_OPEN`) → per materiał: ręcznie `NOT_IN_REQUIREMENTS` / `NOT_INTEGER` / `RESERVE_EXCEEDS_REMAINING` /
  `RESERVE_EXCEEDS_FREE` (detail JSON; błąd = nic nie zapisano), auto min(do zarezerwowania, wolne) (trunc dla
  materiałów całkowitych). Wynik: `reserved[]`, `not_reserved[]` (czego zabrakło). Lista dodana równolegle po odczycie
  zbioru materiałów nie jest uwzględniona (kolejne „Zarezerwuj” ją obejmie).
- `release_reservation(client_request_id, order_id, material_id = null, quantity = null, reason = null)` — BIURO/ADMIN;
  ilość tylko z materiałem; `RELEASE_EXCEEDS` (detail = zarezerwowane), `NOTHING_TO_RELEASE`; dozwolone przy każdym
  statusie zlecenia. Blokady: materiały rosnąco → wiersze rezerwacji.
- `stock_issue` — **nowa sygnatura** (+ `p_override_reservations boolean = false`, `p_override_reason text = null`; stara
  usunięta, stare wywołania działają). Zmiany względem `20261003100000`: override nie-ADMIN → 42501 (przed
  idempotencją); porównanie override przy replay; walidacja powodu (`REASON_REQUIRED` / `VALIDATION`); krok 5b po
  `INSUFFICIENT_STOCK`: wiersze rezerwacji materiału `FOR UPDATE` (rosnąco po zleceniu), wolne = max(stan aktywnych
  lokalizacji − Σ rezerwacji, 0), dozwolone = wolne + własna; przekroczenie → `RESERVED_STOCK` (detail JSON: free,
  own_reserved, reserved_others, orders[≤10]) albo (override) zabranie brakującej części z rezerwacji innych zleceń;
  zapis kolumn override; zdarzenia `CONSUME` (min(ilość, własna)) i `OVERRIDE`; wynik + `reservation_consumed`,
  `reservations_overridden` (replay odtwarza je ze zdarzeń). Reszta bez zmian.
- **Override — kolejność LIFO**: rezerwacje innych zleceń od `last_reserved_at` malejąco (ostatnio zwiększona
  rezerwacja oddaje pierwsza), remis po id. Uzasadnienie: najstarsze rezerwacje są zwykle bliżej produkcji.
  Kolejność rozliczenia: własna rezerwacja → wolne → cudze (LIFO).
- **Auto-zwolnienie**: trigger `production_orders_c_auto_release` AFTER UPDATE OF status, gdy status zmienia się na
  DONE/CANCELLED — w tej samej transakcji; wiersze rezerwacji zlecenia `FOR UPDATE` rosnąco po materiale, zdarzenia
  `AUTO_RELEASE` („Zlecenie zakończone/anulowane”, autor = auth.uid()).
- **Storno wydania** nie odtwarza rezerwacji (świadomie): towar wraca do wolnego; BIURO może zarezerwować ponownie.
- Odczyty: `material_availability(material, order?)` (każda aktywna rola: stan, Σ rezerwacji, wolne, własna, dostępne
  do wydania, nadrezerwacja, zlecenia z rezerwacją), `order_reservations(order)` i `order_reservation_events(order)`
  (ADMIN/BIURO; nazwisko autora z profiles, maks. 500), `over_reserved_materials()` (ADMIN/BIURO).
- Pomocnicza `app.material_free(uuid[])`.

### Kolejność blokad (rozszerza ADR 010/011)

`advisory(client_request_id)` → materiał(y) `FOR NO KEY UPDATE` rosnąco → zlecenie `FOR SHARE` → lokalizacje → wiersze
`stock` → **wiersze `reservations` FOR UPDATE** (w obrębie materiału rosnąco po zleceniu, w obrębie zlecenia rosnąco po
materiale). Trigger auto-zwolnienia trzyma wiersz zlecenia (UPDATE) i blokuje wyłącznie wiersze rezerwacji tego
zlecenia rosnąco po materiale — nie bierze blokad materiałów, więc nie tworzy cyklu z funkcjami (materiał → zlecenie):
wydanie/rezerwacja na zamykane zlecenie czeka na `FOR SHARE` i potem dostaje `ORDER_NOT_OPEN` (test). Łańcuch
oczekiwań między „wiersz po wierszu” (override: jeden materiał, rosnąco po zleceniu; trigger: jedno zlecenie, rosnąco po
materiale) ma niemalejące obie współrzędne — cykl niemożliwy. Wszystkie zwiększenia rezerwacji materiału odbywają się
pod jego blokadą, więc odczyt „wolnego” w wydaniu/rezerwacji jest spójny; zmniejszenia bez blokady materiału (trigger)
tylko zwiększają wolne.

### Braki, widoki, kartoteka

- Per zlecenie (`order_shortages`, `order_overview`, `order_to_issue`): dostępne dla zlecenia = wolne + własna
  rezerwacja; `order_shortages` +kolumny `reserved`, `free`; `order_to_issue` +`reserved` (DROP+CREATE — zmiana typu
  wyniku). **Zbiorczo** (`shortage_rows`, `/braki`) bez zmian — stan liczony raz (rezerwacje są wewnątrz tego samego
  zbioru zleceń).
- `v_material_stock` +`reserved_quantity`, `free_quantity`, `over_reserved`; `v_stock` +`material_reserved`.
  „Poniżej minimum” — po review **liczone od WOLNEGO** (decyzja użytkownika, patrz „Poprawki po review”).
- `dashboard_stats` +`reserved_materials`, `over_reserved`.
- Dezaktywacja materiału z aktywną rezerwacją → `HAS_RESERVATIONS` (409).
- `purge_test_stock(material_ids, order_ids = null)` — usuwa zdarzenia i rezerwacje materiałów testowych oraz żądania
  wskazanych zleceń (przerywa, gdy zlecenie ma rezerwacje spoza danych testowych). Do usunięcia przed startem.

## API

| Endpoint | Role | Odpowiedzi |
|---|---|---|
| `GET /api/v1/orders/[id]/reservations` | ADMIN, BIURO | pozycje + historia zdarzeń |
| `POST /api/v1/orders/[id]/reservations` `{client_request_id, items?}` | ADMIN, BIURO | 201 / 200 replay / 409 `RESERVE_EXCEEDS_FREE`/`_REMAINING` (details), `ORDER_NOT_OPEN`, `IDEMPOTENCY_CONFLICT` / 400 `NOT_IN_REQUIREMENTS` |
| `POST /api/v1/orders/[id]/reservations/release` `{client_request_id, material_id?, quantity?, reason?}` | ADMIN, BIURO | 201 / 200 / 409 `RELEASE_EXCEEDS`, `NOTHING_TO_RELEASE` |
| `GET /api/v1/stock/availability?materialId=&orderId=` | wszyscy | dostępność z rezerwacjami |
| `POST /api/v1/stock/issues` + `override_reservations`, `override_reason` | override: tylko ADMIN (403 w handlerze + 42501 w DB) | 409 `RESERVED_STOCK` (`details.available/free/ownReserved/reservedOthers/orders`) |

CSRF, zod `.strict()`. `GET /stock` zwraca `materialReserved`; sumy per materiał — `reservedQuantity`, `freeQuantity`, `overReserved`.

## UI

- Desktop zlecenie: sekcja **Rezerwacje** (potrzebne, wydano, zarezerwowane, do zarezerwowania, wolne; „Zarezerwuj
  wszystko”, „Zarezerwuj” z ilością (podpowiedź `suggestReserveQuantity`), „Zwolnij…” część/całość z powodem i
  potwierdzeniem, „Zwolnij wszystkie”; historia zwinięta; ostrzeżenie o nadrezerwacji; „zarezerwowano ponad pozostało”).
  Idempotencja: ten sam id przy ponowieniu po błędzie sieci. Braki zlecenia: kolumny Zarezerwowane / Wolne / Dostępne.
  Pytanie przy zamykaniu zlecenia mówi o zwolnieniu rezerwacji.
- Magazyn (suma per materiał): kolumny Zarezerwowane, Wolne, odznaka „rezerwacje przekraczają stan”; per lokalizacja —
  dopisek „materiał zarezerwowany: X”. Szczegóły materiału: zarezerwowane/wolne, ostrzeżenie, lista zleceń z rezerwacją.
- Dashboard: kafel „Materiały z rezerwacją” (+liczba nadrezerwacji) i ostrzeżenie z listą materiałów.
- Terminal WYDANIE: „Dostępne dla tego zlecenia: X (w tym rezerwacja tego zlecenia: Y)” / „Wolne: X” + „zarezerwowane
  dla innych zleceń: Y”; blokada ilości ponad dostępne (PRODUKCJA); ADMIN przechodzi do podsumowania w trybie
  „Wydanie mimo rezerwacji” z wymaganym powodem (ZATWIERDŹ zablokowany do czasu powodu, `useConfirmGuard`), po
  `RESERVED_STOCK` z serwera przycisk „Wydaj mimo rezerwacji…”; „Do wydania na to zlecenie” pokazuje rezerwację i
  podpowiada ilość = min(pozostało, w lokalizacji, dostępne dla zlecenia); ekran wyniku pokazuje zużytą rezerwację i
  zmniejszone cudze rezerwacje.

## Decyzje własne

- Przy nadrezerwacji dozwolone dla zlecenia = wolne(0) + własna (dosłownie wg decyzji 3), ograniczone stanem lokalizacji.
- Flaga override zapisywana tak, jak przyszła (także gdy nie trzeba było nic zabierać) — deterministyczne porównanie
  przy replay; faktycznie zabrane rezerwacje widać w zdarzeniach OVERRIDE.
- Wycofanie listy zapotrzebowania nie zmienia rezerwacji (bez „magii”) — po review: ostrzeżenie + „Zwolnij nadmiar” (decyzja użytkownika M1b).
- `reserve_for_order` w trybie auto bez wolnego towaru kończy się sukcesem z `not_reserved` (informacja, nie błąd).

## Ograniczenia

- Historia ruchów (`list_stock_movements`) nie pokazuje flagi/powodu override — są w operacji i w historii rezerwacji
  zlecenia (link „operacja”).
- Desktopowy formularz wydania ADMIN-a nie ma opcji override (komunikat `RESERVED_STOCK`); override — terminal i API.
- `created_at` zdarzeń z jednej transakcji jest równy (sortowanie pomocniczo po id) — przy replay wydania z override lista `reservations_overridden` może mieć inną kolejność niż w oryginalnej odpowiedzi (te same pozycje; klient używa tylko sumy). Wykryte w pełnym przebiegu test:db; test porównuje zbiór.

## Poprawki po review (migracja `20261004110000_reservations_review_fixes.sql`)

Decyzje użytkownika (M1):
- **M1a — „poniżej minimum” od wolnego** (stan w aktywnych lokalizacjach − rezerwacje, min. 0), zgodnie z ADR 012:
  `v_stock.below_minimum` (+ kolumna `material_free`), `v_material_stock` (`below_minimum`, `shortage` = minimum −
  wolne, `in_view`), `dashboard_stats` (przez widok), `export_stock_csv`: wariant materiałowy + kolumny
  „Zarezerwowane;Wolne” (po „Stan łączny”), lokalizacyjny + „Zarezerwowane (materiał);Wolne (materiał)” na końcu.
  Przykład z testów: minimum 20, stan 25, rezerwacja 10 → poniżej minimum, brakuje 5.
- **M1b — rezerwacje ponad zapotrzebowanie** (np. po wycofaniu listy): nic nie dzieje się automatycznie, ale
  (1) pytanie przy wycofaniu listy wylicza przewidywany nadmiar (`excessAfterWithdraw`), a sekcja Rezerwacje pokazuje
  „Zlecenie ma rezerwacje ponad nowe zapotrzebowanie: [materiał: X jedn.]” z przyciskiem **„Zwolnij nadmiar”**
  (potwierdzenie; `release_reservation_excess(crid, order)` — jedna transakcja, blokady jak `release_reservation`,
  bilans liczony po blokadach, zdarzenia RELEASE z powodem „Nadmiar po wycofaniu listy”, idempotencja; API
  `POST /orders/[id]/reservations/release-excess`); (2) dashboard: kafel „Rezerwacje ponad zapotrzebowanie” (liczba
  zleceń, `dashboard_stats.over_requirement_orders`) i lista zleceń/materiałów z linkami
  (`reservations_over_requirement(order?)`, tylko zlecenia OPEN/IN_PRODUCTION).
- **L5 — rezerwacja równoległa z wycofaniem listy**: `withdraw_requirement` nie blokuje zlecenia ani materiałów, więc
  „Zarezerwuj” może policzyć pozostało do zarezerwowania sprzed wycofania. Wynik jest poprawny transakcyjnie, ale
  rezerwacja może przekroczyć nowe zapotrzebowanie — jest wtedy widoczna jako nadmiar (`excess`) z ostrzeżeniem M1b
  i przyciskiem „Zwolnij nadmiar”, oraz na dashboardzie.

Pozostałe:
- **M2** — testy z wymuszonym przeplotem (bramka, dwa połączenia): zamknięcie zlecenia w trakcie wydania ADMIN-a z
  override zabierającym jego rezerwację, w trakcie `release_reservation` tego zlecenia, wydanie na zlecenie (CONSUME)
  vs zamknięcie w obu kolejnościach; losowa mieszanka (6 rund × 12 równoległych operacji: reserve, wydania na
  zlecenie / bez zlecenia / override, release, DONE/CANCELLED/OPEN/IN_PRODUCTION, `stock_adjust` z aktualnym
  `expected_current`, przyjęcia; 3 materiały × 2 lokalizacje × 4 zlecenia). Asercje: brak 40P01 i błędów spoza
  domenowych, rezerwacja = Σ zdarzeń, brak rezerwacji > 0 na DONE/CANCELLED, brak stanu < 0, `verify_stock` puste.
- **L1** — `reservation_events`: SELECT tylko ADMIN/BIURO (terminal używa `material_availability`).
- **L2** — `purge_test_stock(p_order_ids)`: żądania wyłącznie zleceń o nazwie `TEST-…` (inne id pomijane; test).
- **L3** — terminal: błąd `/stock/availability` → „Nie udało się sprawdzić rezerwacji” + „Ponów” (decyduje serwer).
- **L4** — po rezerwacji klucz ilości usuwany (podpowiedź liczona od nowa).
- **L6** — korekta w dół (desktop i terminal): w panelu potwierdzenia ostrzeżenie, gdy po korekcie Σ rezerwacji > stan
  (`reservationShortfallAfterAdjust`); mobilne SZUKAJ pokazuje zarezerwowane / wolne (+ flaga nadrezerwacji).
- **L7** — `stock_issue` nie był zmieniany w tej migracji; komentarz w nagłówku sekcji 4 („Etap 11 rezerwacje” przy
  blokadzie materiału) jest już aktualny, a dawny opis „TU W ETAPIE 11 …” został usunięty w `20261004100000`.
  Ewentualne porządki komentarzy — przy najbliższej zmianie funkcji.
- **Desktop „Wydania” (ADMIN)**: po `RESERVED_STOCK` przycisk „Wydaj mimo rezerwacji…” → panel z powodem i
  potwierdzeniem (`useConfirmGuard`), nowe żądanie z `override_reservations`; komunikat INSUFFICIENT_STOCK tylko dla tego
  kodu (wcześniej każdy błąd z `available`).

## Postęp

- [x] Migracja (ROLLBACK z próbą funkcjonalną → `db:push`, wgrana)
- [x] Serwer/API, UI desktop, terminal
- [x] Testy DB `tests/db/reservations.test.ts` (16), unit `tests/unit/reservations.test.ts`
- [x] Weryfikacja: lint, typecheck, test 724/724, test:db 335/335 (11 plików), build, cf:build, check:size 1808,5 KiB,
  check:secrets, db:migrations; smoke HTTP na `wrangler dev` i przeklikanie (desktop + terminal 375 px)
- [x] Poprawki po review: migracja `20261004110000` (ROLLBACK → db:push, wgrana), serwer/API, UI, testy DB (24 w pliku), unit
- [x] Pełna weryfikacja po review: lint, typecheck, test 727/727, test:db 343/343 (11 plików), build, cf:build, check:size 1821,3 KiB, check:secrets, db:migrations; przeklikane M1a (dashboard), M1b (wycofanie → ostrzeżenie → Zwolnij nadmiar), override na desktopie
