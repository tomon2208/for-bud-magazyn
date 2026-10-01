# ADR 007 — Kartoteki: kategorie, dostawcy, materiały

## Uprawnienia (egzekwowane w RLS i ponownie w API)

| | odczyt | zapis (insert/update) |
|---|---|---|
| `material_categories` | każdy aktywny użytkownik | ADMIN |
| `suppliers` | każdy aktywny użytkownik | ADMIN, BIURO |
| `materials` | każdy aktywny użytkownik | ADMIN |

Polityki używają `(select app.user_role())` — nieaktywny użytkownik (`NULL`) i `anon` nie widzą nic. Operacje wykonuje klient użytkownika (klucz publishable + sesja), nie klucz secret: RLS jest drugą linią obrony obok `requireApiRole`.

## Brak DELETE

Kartotek nie usuwamy — dezaktywujemy (`active = false`). Będą na nie wskazywać ruchy magazynowe, zlecenia i zapotrzebowania. `DELETE` jest odebrany wszystkim rolom aplikacyjnym (brak GRANT i polityk); ma go wyłącznie `service_role` (sprzątanie danych testowych). Dezaktywacja kategorii/dostawcy nie zmienia istniejących materiałów, ale nowego przypisania do nieaktywnej kategorii/dostawcy odmawia trigger (`hint = INACTIVE_CATEGORY | INACTIVE_SUPPLIER`, API: 400). Trigger blokuje wiersz powiązania (`FOR SHARE`), więc równoległa dezaktywacja nie wyprzedzi zapisu materiału.

## Dane

- **Kod materiału**: segmenty `[A-Z0-9._/-]` rozdzielone POJEDYNCZĄ spacją, 1–50 znaków (`^[A-Z0-9._/-]+( [A-Z0-9._/-]+)*$`); decyzja użytkownika — kody typu `K518 RAL9016`. Normalizacja (trigger `upper(btrim(regexp_replace(code, '\s+', ' ', 'g'))))` i zod): białe znaki → jedna spacja, trim, WIELKIE litery (`'  k518   ral9016 '` → `K518 RAL9016`). Dzięki temu zwykły `unique (code)` jest bezwzględny wobec wielkości liter i liczby spacji. Pierwotnie (migracja `20261001140000`) spacje były zabronione; zmieniono migracją `20261001170000`. Kod można edytować (unikalność pilnuje baza).
- **Trigger `materials_before_write`** (SECURITY DEFINER, uruchamiany przed RLS) na początku odrzuca zapis (42501) roli `authenticated`, która nie jest ADMIN-em — zanim założy blokadę `FOR SHARE` na kategorii/dostawcy (migracja `20261001160000`).
- **Lista materiałów**: strona poza zakresem (PGRST103) zwraca prawdziwe `total` (osobny `count` z tymi samymi filtrami); UI przechodzi na ostatnią stronę.
- **Nazwy** kategorii i dostawców: przycięte, niepuste (≤ 80 / ≤ 200), unikalność przez `unique index (lower(name))`.
- **Jednostka**: tekst (≤ 20 znaków), nie enum — jest właściwością materiału, a lista będzie rosnąć (BUSINESS_RULES). UI podpowiada: szt., sztanga, mb, opak., kg, l, m² (`datalist`).
- **Audyt**: `created_at/by`, `updated_at/by` ustawia trigger z `auth.uid()` (klient nie może ich podrobić; `created_*` i `id` są niezmienne). FK do `profiles` bez kaskady — historia autorstwa nie znika.
- Puste pola opcjonalne dostawcy (kontakt, telefon, e-mail, uwagi) są zapisywane jako `NULL`.

## Indeksy

Przy skali FOR-BUD (setki–tysiące materiałów) wystarczą: `unique (code)` (btree), indeksy na kluczach obcych `category_id` i `default_supplier_id` (filtr po kategorii, sprawdzanie FK) oraz unikalne `lower(name)`. Wyszukiwanie `ilike '%q%'` po kodzie i nazwie przy takiej liczbie wierszy to sekwencyjny skan rzędu pojedynczych milisekund; `pg_trgm` (GIN) dodałby indeks, który nie zwróci się przy tej skali i komplikuje migracje. Do ponownej oceny, gdy liczba materiałów przekroczy ~50 tys. albo wyszukiwanie mobilne (Etap 7) okaże się wolne — wtedy `create extension pg_trgm` + indeksy GIN na `code` i `name`.

## Wyszukiwanie (`q`) — bezpieczeństwo

Fraza trafia do filtra PostgREST `.or("code.ilike.<v>,name.ilike.<v>")`, więc: znaki LIKE (`\`, `%`, `_`) są escapowane (dosłowne dopasowanie), wartość jest ujęta w cudzysłowy z escapowaniem `\` i `"` (przecinki, nawiasy, kropki nie rozbijają filtra, brak wstrzyknięcia kolejnych warunków). PostgREST traktuje `*` w like/ilike jako alias `%` bez możliwości escapowania — zamieniamy go na `_` (jednoznakowy wildcard). Maks. długość frazy: 100 znaków. Pokryte testami jednostkowymi i DB.

## API

`/api/v1/categories`, `/suppliers`, `/materials` (+ `/[id]`). Walidacja zod `.strict()` (pola `created_*`, `id` odrzucane), CSRF jak w ADR 006. Błędy: 409 (duplikat: `CODE_TAKEN` / `NAME_TAKEN`), 400 (walidacja, nieistniejące lub nieaktywne powiązanie), 403, 404. Lista materiałów: paginacja (`pageSize` ≤ 100, domyślnie 25), sortowanie po kodzie, `includeInactive`, `categoryId`, `q`.
