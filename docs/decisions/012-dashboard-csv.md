# ADR 012 — Dashboard, stany, stan minimalny, eksport CSV, mobilne SZUKAJ (Etap 7)

Migracja: `supabase/migrations/20261002140000_dashboard_min_quantity.sql`. Funkcji zmieniających stan (`stock_receipt/issue/transfer/adjust/reverse`) nie ruszamy — Etap 7 to wyłącznie odczyty + jedna kolumna kartoteki.

## Stan minimalny (`materials.min_quantity`)

- `numeric(12,3) NULL`, `CHECK (NULL albo 0 ≤ x ≤ 1 000 000)`; **NULL = brak alarmu**.
- Całkowitość: trigger `materials_zz_min_quantity` (BEFORE INSERT/UPDATE, nazwa „zz”, żeby odpalał się po `materials_normalize` — kontrola roli 42501 — i po `materials_z_stock_guard`, który ustala `allows_fraction`). Ułamek przy `allows_fraction = false` → `P0001 / MIN_NOT_INTEGER` (API: 400). Dotyczy też wyłączania ułamków przy ułamkowym minimum. Ten sam warunek w zod (`createMaterialSchema`/`updateMaterialSchema`, gdy `allows_fraction` jawnie `false`) i w formularzu.
- Edycja: ADMIN (jak cała kartoteka materiałów; RLS + trigger). BIURO/PRODUKCJA: UPDATE nie zmienia wiersza (RLS odfiltrowuje — 0 wierszy; INSERT → 42501).
- Formularz materiału: pole „Stan minimalny” (puste → `null` → brak alarmu; przecinek dziesiętny).

**Poniżej minimum** = materiał **aktywny**, `min_quantity IS NOT NULL` i `Σ stan we wszystkich lokalizacjach < min_quantity` (łącznie z lokalizacjami nieaktywnymi; stan 0 przy ustawionym minimum = poniżej). Nieaktywne materiały są pomijane.

**Etap 11 (rezerwacje):** „stan dostępny” = Σ stanu − aktywne rezerwacje. Miejsca zmiany: kolumna `total_quantity` w widoku `v_material_stock` (stąd liczą się `below_minimum`, `shortage`, dashboard, eksport, SZUKAJ) oraz skorelowane podzapytanie `below_minimum` w `v_stock` — oba oznaczone komentarzem w migracji.

## Odczyty (wszystko w SQL, klient użytkownika → RLS)

- `v_stock` rozszerzony **na końcu** o `category_id`, `min_quantity`, `below_minimum` (skorelowane podzapytanie — planista pomija je, gdy kolumna nie jest wybierana).
- `v_material_stock` (`security_invoker`): suma per materiał (także materiały bez stanu), `location_count` (lokalizacje z stanem > 0), `below_minimum`, `shortage`, `in_view` (stan > 0 **albo** poniżej minimum). Widok „suma per materiał” w Magazynie pokazuje `in_view`; mobilne SZUKAJ — wszystkie aktywne materiały pasujące do frazy (także stan 0).
- `dashboard_stats()` → jsonb (aktywne materiały i lokalizacje, materiały ze stanem > 0, poniżej minimum, operacje dziś wg typu — doba `Europe/Warsaw`); ADMIN, BIURO (inaczej 42501). Indeks `stock_operations (created_at desc)`.
- Dashboard: trzy lekkie zapytania równolegle (`dashboard_stats`, lista poniżej minimum z limitem 50 posortowana po największym braku, 15 ostatnich operacji przez `list_stock_movements`). Nie pobieramy historii.
- Paginacja, filtr kategorii, fraza (z escapowaniem LIKE jak w ADR 007) i „tylko poniżej minimum” — w SQL (PostgREST na widokach).

## Eksport CSV

- `GET /api/v1/stock/export?variant=location|material&q=&categoryId=&belowMin=` — **ADMIN, BIURO** (401/403 inaczej). Filtry takie jak w widoku Magazyn (przyciski „Pobierz CSV” budują adres z bieżących filtrów).
- Dane: jedno wywołanie funkcji SQL (patrz „Poprawki po review” — `export_stock_csv`, tekst CSV z bazy; pierwotna wersja `export_stock_rows` była zastąpiona ze względu na CPU Workera). Data API ma `max_rows`, a pętla stron zjadałaby limit subrequestów (Free: 50).
- Format (bez bibliotek): UTF-8 **z BOM**, separator `;`, przecinek dziesiętny (bez separatora tysięcy), CRLF, nagłówki po polsku, flaga „Poniżej minimum” jako TAK/NIE, cudzysłów przy `;` `"` i znakach nowej linii. Nazwa pliku `stany-lokalizacje_RRRR-MM-DD_GGMM.csv` / `stany-materialy_…` (strefa Europe/Warsaw).
- **CSV injection**: komórki TEKSTOWE zaczynające się od `=`, `+`, `-`, `@`, tabulatora lub CR dostają prefiks `'`. Liczby formatowane osobno (ujemna liczba nie jest „tekstem”).
- Wariant (a) per materiał + lokalizacja (stan > 0): kod, nazwa, kategoria, jednostka, lokalizacja, nazwa lokalizacji, ilość. Wariant (b) suma per materiał: + stan minimalny, brak do minimum, poniżej minimum, liczba lokalizacji, domyślny dostawca.

## UI

- Desktop: `/dashboard` (kafle, „Poniżej minimum”, ostatnie operacje), `/magazyn` (przełącznik „Per lokalizacja” / „Suma per materiał”, wyszukiwanie, kategoria, „Tylko poniżej minimum”, URL: `widok`, `q`, `kategoria`, `ponizej`, `page`), `/materialy/[id]` (kartoteka, stan łączny + minimum, rozbicie po lokalizacjach, ostatnie ruchy, link do historii z `?material=`). Kod materiału w listach linkuje do szczegółów.
- Mobile: kafel SZUKAJ → `/m/szukaj` (kod/nazwa, wynik z łącznym stanem i oznaczeniem „poniżej minimum”) → `/m/szukaj/[id]` (stan łączny + „Gdzie leży”: wysokie wiersze lokalizacji z ilościami → `/m/lokalizacje/[code]`). Dostęp: PRODUKCJA i ADMIN (RLS na `stock` i `materials` pozwala czytać każdemu aktywnemu).

## Ograniczenia

- Brak powiadomień o spadku poniżej minimum (tylko widok/dashboard).
- Wyszukiwanie `ilike '%q%'` bez indeksu trigramowego (ADR 007) — do oceny przy > ~50 tys. materiałów.
- `v_material_stock` liczy agregat per materiał (lateral) — przy skali FOR-BUD (tysiące materiałów) to milisekundy; przy wzroście warto rozważyć materializację.

## Poprawki po review (migracja `20261002150000_export_stock_csv_text.sql`)

- **CPU eksportu (H1):** CSV generuje **baza** — `export_stock_csv(variant, q, category, below_min) → text` (SECURITY INVOKER, rola ADMIN/BIURO → inaczej 42501, `search_path=''`). Worker nie parsuje JSON ani nie buduje wierszy: dokleja BOM (`src/lib/csv.ts`) i oddaje string. Zastąpiła `export_stock_rows` (jsonb; usunięta). Pomocnicze funkcje `app.csv_text`, `app.csv_num`, `app.csv_code` (immutable): cytowanie pól z `;` `"` CR LF (podwajanie `"`), neutralizacja CSV injection tekstu zaczynającego się od `=` `+` `-` `@` tab CR (prefiks `'`; wiodąca spacja nie wymaga — Excel nie liczy formuły), liczby z przecinkiem bez zer końcowych i bez separatora tysięcy (ujemne bez prefiksu), TAK/NIE. Limit **20 000 wierszy** → `P0001 / TOO_MANY_ROWS` → API 400 „zawęź filtry”.
- **Kody w Excelu (M1):** kod materiału/lokalizacji, który Excel zinterpretowałby jako liczbę, datę lub notację naukową (`0518`, `518`, `12-03`, `1/2`, `12.05`, długie liczby, `1E5`), jest emitowany jako `="KOD"` — wyłącznie gdy składa się ze znaków `[A-Z0-9._/ -]` (formuła nie może zawierać nic poza literałem). W pliku CSV wygląda to tak: `"=""0518"""`. Pozostałe kody (`K518 RAL9016`, `A-01`) bez zmian; kody spoza bezpiecznego wzorca przechodzą zwykłą neutralizację/cytowanie.
- UI „Pobierz CSV”: `fetch` + blob; błąd (401 po wygaśnięciu sesji, 403, 400 „zawęź filtry”, 5xx) pokazany w UI zamiast pliku JSON; nazwa pliku z `Content-Disposition`.
- Magazyn: pojedynczy zły parametr w URL jest ignorowany bez kasowania pozostałych filtrów; pole wyszukiwania synchronizuje się z URL (menu/Wstecz). Kafel „Materiały ze stanem > 0” ma dopisek, że lista „Suma per materiał” zawiera też materiały poniżej minimum bez stanu. Szczegóły materiału i ekran mobilny pokazują „Pokazano X z Y”, gdy lista lokalizacji jest obcięta.
