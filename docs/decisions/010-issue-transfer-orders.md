# ADR 010 — Wydania, przesunięcia i proste zlecenia (Etap 5)

Migracja: `supabase/migrations/20261002100000_issue_transfer_orders.sql`. Rozwija ADR 009 (rdzeń stocku).

## Zlecenia (`production_orders`) — wersja prosta

- `id`, `name` (NIEunikalna, przycięta, 1–120), `notes` (≤ 500, pusta → NULL), `status` `OPEN | DONE | CANCELLED` (domyślnie OPEN), audyt `created_*/updated_*` z `app.catalog_set_audit` (niepodrabialny).
- Zapis: BIURO, ADMIN (RLS + trigger `production_orders_a_guard_normalize` z kontrolą roli jako pierwszą — 42501 przed jakąkolwiek pracą). Odczyt: każdy aktywny (PRODUKCJA wybiera zlecenie przy wydaniu). Brak DELETE dla ról aplikacyjnych (wskazują na nie operacje); `service_role` — tylko sprzątanie testów. UPDATE przez PRODUKCJĘ: polityka RLS odfiltrowuje wiersze (0 zmienionych, bez błędu).
- Wszystkie przejścia statusów dozwolone (także ponowne otwarcie). Etap 8 rozbuduje zlecenia.
- `stock_operations.production_order_id` → FK do `production_orders(id)` (NO ACTION; kolumna była pusta). Nowa kolumna `reason_code` (CHECK listy) + CHECK-i: wydanie ma dokładnie jedno z (zlecenie, powód); `INNY` wymaga `reason`.

## Wydanie: `public.stock_issue(client_request_id, location_id, material_id, quantity, production_order_id?, reason_code?, reason?, note?)`

Kolejność: rola PRODUKCJA/ADMIN → idempotencja (advisory lock + porównanie: użytkownik, typ ISSUE, materiał, lokalizacja, −ilość, zlecenie, kod powodu, opis i notatka po trim) → walidacja wejścia (zlecenie XOR powód `ISSUE_TARGET`, `INNY` bez opisu `REASON_REQUIRED`, opis tylko bez zlecenia, opis ≤ 200, ilość) → blokady → dostępność → zapis (operacja ISSUE + ruch −qty + UPDATE stanu, flaga `forbud.stock_write`). Zwraca `remaining_location_quantity`.

Powody (stała lista, decyzja użytkownika): `SERWIS` (Serwis/reklamacja), `USZKODZENIE`, `ZUZYCIE_WLASNE`, `PROBKA`, `INNY` (opis wymagany).

Błędy: `INSUFFICIENT_STOCK` (`detail` = dostępna ilość w lokalizacji; API 409 z `error.details.available`), `ORDER_NOT_OPEN` (409), `NOT_FOUND` (`detail` = material/location/order, 404), `ISSUE_TARGET`/`REASON_REQUIRED`/`NOT_INTEGER`/`INVALID_QUANTITY`/`VALIDATION` (400), `IDEMPOTENCY_CONFLICT` (409). Replay po zamknięciu zlecenia zwraca wynik (operacja już się odbyła).

## Przesunięcie: `public.stock_transfer(client_request_id, material_id, from_location_id, to_location_id, quantity, note?)`

1 operacja TRANSFER + 2 ruchy (−qty z A, +qty do B) w jednej transakcji. `from = to` → `SAME_LOCATION`. Idempotencja jak wyżej (porównanie ruchu wychodzącego i przychodzącego). Zwraca stany obu lokalizacji po operacji.

## Kolejność blokad (rozszerza ADR 009 L5)

`advisory(client_request_id)` → **materiał(y)** `FOR NO KEY UPDATE` (rosnąco po id) → **zlecenie** `FOR SHARE` → **lokalizacje** `FOR SHARE` (rosnąco po id) → **wiersze `stock`** `FOR UPDATE` (rosnąco po `location_id`) → dostawca.

- Materiał serializuje wszystkie operacje na nim — dlatego A→B i B→A tego samego materiału nie mogą się zakleszczyć (test: 40 równoległych przesunięć w obie strony). Stała kolejność wierszy stanu chroni przyszłe operacje wielomateriałowe (inwentaryzacja, import).
- **Zlecenie `FOR SHARE`** (nie `FOR KEY SHARE`): koliduje z `UPDATE production_orders` (zmiana statusu). Zamknięcie zlecenia w trakcie wydania czeka na jego koniec (wydanie „przed” zamknięciem); wydanie rozpoczęte po zamknięciu (READ COMMITTED, nowy snapshot po uzyskaniu blokady) dostaje `ORDER_NOT_OPEN`. Równoległe wydania na to samo zlecenie się nie blokują. Oba przeploty pokryte testami SQL z dwoma połączeniami.
- Lokalizacja docelowa przesunięcia `FOR SHARE` — analiza jak dla przyjęcia: dezaktywacja w toku → przesunięcie czeka i dostaje `LOCATION_INACTIVE`; przesunięcie w toku → dezaktywacja czeka i dostaje `LOCATION_NOT_EMPTY` (testy).
- Stan nigdy < 0: sprawdzenie `ilość ≤ stan` pod blokadą materiału i wiersza + `CHECK (quantity >= 0)` jako ostatnia bariera. Testy: stan 10, 5×3 równolegle → 3 sukcesy, 2× `INSUFFICIENT_STOCK`, stan 1; stan 15, 25×1 → 15 sukcesów, stan 0; przesunięcia z A równolegle z wydaniami z A → dokładnie 10 udanych, stan 0.

## Nieaktywne materiały i lokalizacje

- **Wydanie** z nieaktywnego materiału i/lub nieaktywnej lokalizacji jest **dozwolone** (decyzja Tech Leada): pozwala wyczyścić stan „starego” miejsca. Ponieważ dezaktywacja wymaga stanu 0, w praktyce kończy się `INSUFFICIENT_STOCK`. Wydanie tylko zmniejsza stan, więc nie łamie blokad dezaktywacji.
- **Przesunięcie**: lokalizacja **źródłowa może być nieaktywna** (opróżnienie), **docelowa musi być aktywna** (stan w niej rośnie). Materiał nieaktywny dozwolony (jak przy wydaniu).

## Miejsce na rezerwacje (Etap 11)

W `stock_issue` w kroku „5. Dostępność” jest oznaczone miejsce: sprawdzenie `ilość ≤ wolne + pozostała rezerwacja zlecenia` (wolne = Σ stanu materiału − Σ aktywnych rezerwacji innych zleceń) oraz rozliczenie rezerwacji. Rezerwacje blokować po materiale (już zablokowanym). Przesunięcie nie zmienia łącznego stanu materiału — rezerwacje (na poziomie materiału) go nie ograniczają.

## Odczyty

- `list_stock_movements` (nowa sygnatura, stare wywołania nadal działają — nowe parametry mają wartości domyślne): pola `reason_code`, `production_order_id/name`, `from_location_code/to_location_code` (przesunięcia), filtr `p_production_order_id`, `p_collapse_transfers` (przesunięcie jako jeden wiersz — ruch przychodzący). PRODUKCJA nadal tylko własne.
- `GET /api/v1/materials?inStock=true` — tylko materiały ze stanem > 0 (wybór materiału przy wydaniu).

## Klient: jeden mechanizm dla przyjęcia, wydania i przesunięcia

- `src/lib/operation-attempt.ts` (dawniej `receipt-attempt.ts`) + hook `src/lib/use-operation-attempt.ts` — desktopowe formularze ADMIN-a (przyjęcie, wydanie, przesunięcie): po wyniku nieznanym/401 pola zablokowane, ponowienie wysyła dokładnie zapamiętany payload z tym samym id.
- `src/lib/stock-client.ts` — `submitOperation(kind, payload)` (endpoint wg typu; 409 `INSUFFICIENT_STOCK` → `available`).
- `src/lib/pending-operation.ts` (dawniej `pending-receipt.ts`) — sessionStorage, osobny klucz na typ (`forbud.pending.<TYP>`, format v2 z kontekstem do wyświetlenia); hook terminala `src/app/m/use-operation-submit.ts` (blokada podwójnego tapnięcia, `beforeunload`, ekran dokończenia), wspólne elementy UI `src/app/m/wizard-parts.tsx`; baner na `/m` pokazuje niepotwierdzone operacje każdego typu. Zapisy w starym kluczu `forbud.pendingReceipt` (v1) są po wdrożeniu ignorowane — dotyczy tylko kart otwartych w chwili wdrożenia.

## UI

- Terminal: `/m/wydanie` (na co → materiał → lokalizacja z listy albo skan → ilość z „dostępne: X” → podsumowanie → ZATWIERDŹ → „Kolejny materiał na to zlecenie”), z ekranu lokalizacji `?lokalizacja=KOD` (materiał z zawartości lokalizacji); `/m/przesuniecie` (skąd → materiał → ilość → dokąd → podsumowanie), z ekranu lokalizacji `?z=KOD`. „Moje ostatnie operacje (24 h)” — przyjęcia, wydania, przesunięcia.
- Desktop: „Zlecenia” (lista, filtr statusu, wyszukiwanie, dodawanie, edycja, zmiana statusu z potwierdzeniem, szczegóły z podsumowaniem wydań per materiał), „Wydania” z zakładką „Przesunięcia” (filtr zlecenia, materiału, dat; ADMIN — formularze wydania i przesunięcia).

## Poprawki po review (Etap 5)

- **M1:** zlecenia o tej samej nazwie rozróżnia `orderSubLabel` („utw. dd.mm.rrrr, gg:mm · notatka”) — na liście wyboru (terminal i desktop), w wierszu kontekstu „Zlecenie”, na podsumowaniu, ekranie dokończenia i w komunikacie sukcesu wydania (`IssueTarget.sub`).
- **M2:** desktop nie ładuje 200 zleceń: formularz wydania ADMIN-a i filtr „Zlecenie” w „Wydaniach” używają wyszukiwarki (`src/components/order-search.tsx`, `GET /api/v1/orders?status=&q=`); wybrane zlecenie filtra strona pobiera po id.
- **L1/L2/L3:** `INSUFFICIENT_STOCK` od razu ustawia aktualną dostępność i pokazuje ją z jednostką; po wznowieniu dostępność jest pobierana (`fetchStock`); po błędach innych niż ilościowe kreator wraca do właściwego kroku (zlecenie / materiał / lokalizacja docelowa), etykieta przycisku zależy od błędu; w przesunięciu wiersz „Dokąd” ze „Zmień”.
- **L4:** podsumowanie wydań na zlecenie liczy funkcja SQL `public.order_issue_summary(order_id)` (SECURITY INVOKER — RLS; `sum` + `group by`), migracja `20261002110000_order_issue_summary.sql`.

## Uwagi na Etap 6 (korekty, historia)

- CHECK `stock_operations_reason_code_valid` jest **globalny** (wszystkie typy operacji) — jeśli korekty ADMIN-a dostaną własne kody powodów, trzeba go rozszerzyć albo uzależnić od `type`; CHECK `stock_operations_reason_other` (INNY ⇒ opis) też dotyczy wszystkich typów.
- **Storno/korekta wydania musi wejść do podsumowania zlecenia** (`order_issue_summary` sumuje dziś tylko operacje `ISSUE` danego zlecenia) — np. korekta ze wskazaniem `production_order_id` uwzględniona w sumie albo osobna kolumna „skorygowano”.

Rozwiązane w Etapie 6 (ADR 011): CHECK kodów powodów jest per typ operacji; storno wydania kopiuje zlecenie i `order_issue_summary` liczy wydania netto (+ kolumna `reversals`).
