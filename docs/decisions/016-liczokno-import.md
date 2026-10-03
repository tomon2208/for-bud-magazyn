# ADR 016 — Import zapotrzebowania z LiczOkno (Etap 12a)

Migracja: `supabase/migrations/20261006100000_liczokno_import.sql`. Rozwija ADR 013 (listy zapotrzebowania `source='IMPORT'`, `imported_file_name`, `import_format`, `raw_source_ref` były już w modelu) i `docs/LICZOKNO.md`. Bez odpowiedników materiałów (Etap 12b).

## Decyzje użytkownika (2026-10-03)

1. **„Szukaj też profili”** — checkbox przy imporcie, domyślnie WYŁĄCZONY. Profil = pozycja z grupy, której nazwa zaczyna się od „Profile” (bez względu na wielkość liter). Wyłączone → pozycje profili widoczne na podglądzie jako „Pominięty — profile”, nie trafiają na listę. Włączone → jak pozostałe pozycje, z przeliczeniem metrów na sztangi (pkt 5).
2. **Kody w kartotece = „Kod elementu” z LiczOkno** → dopasowanie po kodzie (normalizacja jak w bazie: trim, białe znaki → jedna spacja, UPPERCASE — migracja `20261001170000`). Nieznany kod: (a) **Wskaż materiał** (wyszukiwarka; „Zapamiętaj powiązanie”, domyślnie zaznaczone → zapis powiązania), (b) **Załóż materiał** (tylko ADMIN; formularz wypełniony z pliku: kod, nazwa = Opis, jednostka „m” → „mb”, „szt.” → „szt.”; kategorię wybiera użytkownik; po utworzeniu pozycja dopasowuje się ponownie), (c) **Nie magazynujemy**, (d) **Pomiń tylko teraz**.
3. **Lista „nie magazynujemy”** — kod oznaczony raz jest pomijany w kolejnych importach (na podglądzie „Pominięty — nie magazynujemy”, z „Cofnij oznaczenie”).
4. **Uruchamianie** (BIURO, ADMIN; desktop): z karty zlecenia „Importuj z LiczOkno” (nowa lista `source='IMPORT'`) oraz z `/zlecenia` „Nowe zlecenie z pliku” (nazwa zlecenia podpowiadana z nagłówka pliku, opcjonalny numer; zlecenie i lista powstają ATOMOWO jedną funkcją SQL).
5. **Przeliczanie jednostek** — nowa kolumna kartoteki `materials.bar_length_m` („Długość sztangi [m]”, opcjonalna, `numeric(6,3)`, `> 0` i `≤ 20`, edytowalna przez ADMIN-a w formularzu materiału, widoczna na liście i w karcie materiału). Reguły per pozycja (po zsumowaniu wierszy tego samego kodu):
   - jednostka pliku == jednostka materiału (po normalizacji) → ilość bez zmian, zaokrąglona do 3 miejsc (usuwa szum float),
   - plik w „m”, materiał ma `bar_length_m` → `ceil(suma_m / bar_length_m)` z tolerancją 1e-9 (13,0 / 6,5 = 2, nie 3); podgląd „44,2 m → 7 szt.”,
   - inaczej → błąd „Niezgodna jednostka (plik: m, kartoteka: szt.)” — pozycję trzeba pominąć albo wpisać ilość ręcznie,
   - ten sam kod z różnymi jednostkami w pliku → błąd pozycji; ilość ułamkowa dla materiału bez ułamków (`allows_fraction=false`) → błąd do ręcznej poprawy.
   Normalizacja jednostek: {m, mb, m.b., mb.} → „m”; {szt, szt., sztuk, sztuka} → „szt”; inne → trim + lowercase. Ilość na podglądzie jest zawsze edytowalna (walidacja jak `quantitySchema`).
6. **Materiał nieaktywny** → błąd pozycji (wskaż inny / pomiń).

## Architektura

- **Parsowanie wyłącznie w przeglądarce** (limit CPU 10 ms i rozmiar Workera 3 MiB, PLAN sekcja 0). Do Workera trafia tylko znormalizowany JSON (kody, przeliczone ilości, `raw_source_ref`).
- **SheetJS 0.20.3** z oficjalnego CDN (`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`) — npm `xlsx` 0.18.5 ma znane podatności (CVE-2023-30533, CVE-2024-22363). Ładowana dynamicznym `import("xlsx")` wyłącznie w `read-workbook.ts` (wywoływanym z komponentu importu), więc nie trafia do bundla Workera ani innych stron. Pliki: `.xls`, `.xlsx`, `.csv` (UTF-8 albo Windows-1250), limit 5 MB. CSV czytany z `raw: true` — przecinek dziesiętny „7,432” nie zamienia się w 7432; liczby czyta parser formatu.
- **Moduł `src/modules/liczokno-import/`** — parser oddzielony od domeny (specyfika Excela nie przenika do tabel):

| Plik | Rola |
|---|---|
| `read-workbook.ts` | plik → pierwszy arkusz jako `unknown[][]` (jedyne miejsce z SheetJS) |
| `types.ts` | `ImportFormat { id, label, detect, parse }`, `ParsedImport`, `ParsedLine`, `ImportParseError` |
| `formats/lista-materialowa.ts` | format „Lista materiałowa” (id `liczokno-lista-materialowa`) |
| `formats/index.ts` | rejestr formatów, `detectFormat`, `parseImport` (brak dopasowania → „Nieznany format pliku”) |
| `normalize.ts` | czyste funkcje: `normalizeUnit`, `round3`, `aggregateLines` (sumowanie po znormalizowanym kodzie) |
| `resolve.ts` | `buildPreview` (statusy, przeliczenie sztang, `raw_source_ref`), `buildImportItems`, `summarizePreview` |

  Nowy format w przyszłości = nowy plik w `formats/` + wpis w rejestrze (patrz `docs/LICZOKNO.md`).
- **Statusy podglądu:** OK, PRZELICZONO, NIEZNANY, NIE_MAGAZYNUJEMY, PROFIL_POMINIETY, BLAD_JEDNOSTKI, NIEAKTYWNY, NIE_CALKOWITA, BLAD_ILOSCI (błędna ręcznie wpisana ilość), POMINIETY_RECZNIE. Zapis listy jest zablokowany, dopóki są pozycje „do rozwiązania” albo nie ma ani jednej gotowej.

## Baza (migracja `20261006100000_liczokno_import.sql`)

| Obiekt | Opis |
|---|---|
| `materials.bar_length_m` | `numeric(6,3)`, CHECK `> 0 and <= 20` |
| `import_code_aliases` | `source_code` (unikalny, znormalizowany, ≤ 50, ten sam regex co kod materiału), `action` MAP / IGNORE, `material_id` (NOT NULL dla MAP, NULL dla IGNORE — CHECK; `on delete cascade`), audyt created/updated. SELECT: aktywni BIURO/ADMIN (RLS). Zapis wyłącznie funkcjami; `service_role`: SELECT + DELETE (sprzątanie testów) |
| `upsert_import_alias(code, action, material_id)` | BIURO/ADMIN (inaczej 42501), SECURITY DEFINER, `search_path=''`; walidacje: `INVALID_CODE`, `VALIDATION`, `NOT_FOUND`, `MATERIAL_INACTIVE` (MAP na nieaktywny); upsert po kodzie |
| `delete_import_alias(id)` | BIURO/ADMIN; `NOT_FOUND`. Usunięcie jest dozwolone — to konfiguracja, nie historia ruchów |
| `resolve_import_codes(codes[])` | BIURO/ADMIN, ≤ 1000 kodów, jeden round-trip; wiersz na DISTINCT kod po normalizacji: `ALIAS_MAP` / `IGNORED` / `MATERIAL` / `UNKNOWN` + `alias_id` i dane materiału (id, kod, nazwa, jednostka, `allows_fraction`, `bar_length_m`, `active`). Kolejność: powiązanie (jawna decyzja) → dokładny kod materiału → nieznany |
| `app.create_requirement_core(...)` | wspólny rdzeń walidacji i zapisu listy (1–500 pozycji, `DUPLICATE_MATERIAL`, `INVALID_QUANTITY`, `NOT_INTEGER`, `MATERIAL_INACTIVE`, `ORDER_NOT_OPEN` + zlecenie `FOR SHARE`, idempotencja z `request_hash`) używany przez `create_requirement` i `import_requirement` |
| `app.requirement_request_hash`, `app.requirement_check_shape` | odcisk żądania i kontrola struktury `p_items`; odcisk MANUAL identyczny jak w migracji `20261003110000` (powtórzenia sprzed migracji nadal są replayem) |
| `create_requirement(order, name, items, client_request_id?)` | ta sama sygnatura, role i odpowiedź (`requirement_id`, `item_count`, `idempotent_replay`) — cienka nakładka na rdzeń, źródło MANUAL |
| `import_requirement(order_id, new_order, name, file_name, import_format, items, client_request_id)` | BIURO/ADMIN; dokładnie jedno z `order_id` / `new_order {name, number?}`; `client_request_id` wymagany; pozycje `{material_id, quantity, note?, raw_source_ref?}`; zwraca `{order_id, requirement_id, item_count, order_created, idempotent_replay}`; `NUMBER_TAKEN` (409) przy duplikacie numeru |

**Atomowość:** nowe zlecenie i lista powstają w jednej transakcji funkcji — błąd pozycji (np. `NOT_INTEGER`) lub zajęty numer cofa także zlecenie. **Idempotencja:** `request_hash` obejmuje też `raw_source_ref`, plik i format (dla importu) oraz „zakres” (id zlecenia albo `NEW:<nazwa>|<numer>`); powtórzenie tej samej treści tym samym użytkownikiem → replay (200, bez drugiego zlecenia), inna treść / inny użytkownik → `IDEMPOTENCY_CONFLICT`. Funkcja NIE wykonuje `ANALYZE` — po masowym imporcie `ANALYZE requirements, requirement_items` (ADR 013, L1).

## API (zod `.strict()`, `requireApiRole("ADMIN","BIURO")`, CSRF)

- `POST /api/v1/import/resolve` `{codes[]}` → dopasowanie kodów (POST, bo do 1000 kodów; operacja tylko do odczytu).
- `GET /api/v1/import/aliases`, `PUT /api/v1/import/aliases` `{source_code, action, material_id?}`, `DELETE /api/v1/import/aliases/[id]`.
- `POST /api/v1/import/requirements` `{order_id? | new_order?, name, file_name, import_format, items[], client_request_id}` → 201 (lub 200 replay) z `orderId`, `requirementId`, `itemCount`, `orderCreated`.
- Błędy mapuje `mapRequirementError` (rozszerzony o `NUMBER_TAKEN` 409 i `INVALID_CODE` 400). Walidacja: `src/lib/validation/import.ts`; długość sztangi: `checkBarLength` w `catalog.ts` (przecinek dziesiętny, `PATCH/POST /materials` przyjmują `bar_length_m`).

## UI (desktop; BIURO, ADMIN — PRODUKCJA nie widzi przycisków, strony przekierowują)

- `/zlecenia/[id]/import` i `/zlecenia/import` — wspólny komponent kliencki `import-view.tsx`: (1) wybór pliku → parsowanie w przeglądarce → format, nazwa zlecenia z nagłówka, data, liczba pozycji; (2) checkbox „Szukaj też profili” (zmiana przelicza podgląd bez ponownego wczytywania pliku); tabela podglądu (kod/opis, ilość z pliku, materiał, edytowalna ilość + jednostka kartoteki, status, akcje wg statusu), licznik gotowe / do rozwiązania / pominięte, filtr; (3) nazwa listy (domyślnie z nagłówka, fallback nazwa pliku; ≤ 120), dla nowego zlecenia nazwa zlecenia + numer; ostrzeżenie (nie blokada), gdy zlecenie ma już AKTYWNĄ listę z tym samym plikiem; po zapisie przekierowanie na `/zlecenia/[id]` (sekcja Braki pokazuje porównanie z magazynem).
- Kolejność wierszy: pozycje do rozwiązania na górze, potem gotowe, potem pominięte — według STANU WCZYTANIA (wiersz nie „skacze” po rozwiązaniu).
- `client_request_id` stały dla identycznej treści (wzorzec M1 z ADR 013), nowy po zmianie.
- Karta zlecenia: przycisk „Importuj z LiczOkno”, plakietka „Import LiczOkno” i nazwa pliku przy listach IMPORT. `/zlecenia`: „Nowe zlecenie z pliku”.
- `/materialy/powiazania-liczokno` (link z `/materialy`): tabela kod → materiał / „nie magazynujemy”, filtr, usuwanie z potwierdzeniem.
- Formularz materiału: „Długość sztangi [m]”; lista materiałów: kolumna „Sztanga [m]”; karta materiału: długość sztangi w nagłówku.

## Decyzje własne

- Rola do zapisu powiązań: funkcje SECURITY DEFINER z kontrolą roli (wzorzec `create_requirement`), nie RLS per rola — BIURO nie ma uprawnień do tabeli kartoteki, a powiązania zapisuje.
- `bar_length_m` edytuje tylko ADMIN (jak cała kartoteka); BIURO nie ustawia długości sztangi (może wskazać materiał i zapamiętać powiązanie).
- Kod z pliku, który nie spełnia regexu kodu materiału (np. znaki spoza `A–Z 0–9 . _ / -`), nie może zostać zapamiętany ani oznaczony „nie magazynujemy” (`INVALID_CODE`) ani założony jako materiał; można go wskazać „tylko teraz” albo pominąć.
- `resolve_import_codes` zwraca dla kodu `IGNORED` także dane materiału o tym samym kodzie (jeśli istnieje) — klient i tak pomija pozycję; tak powiązanie IGNORE ma pierwszeństwo przed kodem materiału.
- Profil tylko, gdy WSZYSTKIE wiersze danego kodu są w grupie „Profile…” (w razie wątpliwości importujemy).
- Kilka pozycji pliku wskazujących ten sam materiał (np. dwa kody powiązane z jednym materiałem) jest scalane przy zapisie (suma ilości, połączone odwołania ≤ 200 znaków) — lista ma materiał raz; UI pokazuje informację o scaleniu.
- „Pomiń tylko teraz” i ręcznie wskazany materiał (bez zapamiętania) żyją tylko w stanie przeglądarki.
- Powiązanie MAP na materiał nieaktywny jest odrzucane już przy zapisie (`MATERIAL_INACTIVE`); nieaktywny materiał dopasowany po kodzie pokazuje się na podglądzie jako błąd pozycji.
- Prawdziwy plik klienta (`docs/przykladowy_wzor/`) jest poza gitem; test na nim (`tests/unit/liczokno-real-file.test.ts`) jest pomijany, gdy pliku brak.

## Ograniczenia

- Jeden arkusz (pierwszy) i jeden format („Lista materiałowa”); kolejne formaty = nowe pliki w `formats/`.
- Maksymalnie 1000 różnych kodów w pliku i 500 pozycji na listę (limit `create_requirement`); plik do 5 MB.
- Brak odpowiedników materiałów („brak XXX, ale jest YYY”) — Etap 12b.
- Przeliczenie sztang tylko `m → sztuki/sztangi` wg `bar_length_m`; inne konwersje jednostek wymagają ręcznej ilości.
- Testy DB (`tests/db/import.test.ts`) wymagają migracji na bazie dev (`pnpm db:push`).

## Poprawki po review (w tej samej migracji i zmianie)

- **M1 — „Załóż materiał” dla profilu:** pozycja z grupy „Profile…” podpowiada jednostkę „szt.” (sztanga jest jednostką magazynową — CLAUDE.md, reguła 6), a „Długość sztangi [m]” jest wymagana (bez niej metry z pliku nie przeliczą się na sztangi). Nie-profile w „m” nadal dostają „mb”. Gdy jednostka to m/mb i podano długość sztangi, formularz ostrzega, że pole nie ma skutku (przeliczanie dotyczy materiałów liczonych w sztukach/sztangach).
- **M2 — CSV:** separator (`;` TAB `,`) wykrywany z wiersza nagłówka zawierającego „Kod elementu” (zliczanie poza cudzysłowami; remis → `;`) i przekazywany do SheetJS jako `FS` — tytuł z przecinkami nie myli wykrywania. Testy `readWorkbookRows` na małych CSV: `;`, TAB, `,`, przecinek dziesiętny, tytuł z przecinkami, UTF-8 (także BOM) i Windows-1250.
- **M3 — `import_requirement`:** `new_order.name` musi być tekstem JSON, `number` — brak / null / tekst; inaczej `VALIDATION` (np. `{"name": 5}` nie tworzy już zlecenia „5”).
- **M4 — scalanie kodów o tym samym materiale:** gdy WSZYSTKIE scalane pozycje są w metrach przeliczonych na sztangi (bez ręcznej zmiany ilości), metry są sumowane przed zaokrągleniem: `ceil(Σm / L)` (nie suma osobnych `ceil`). Przy mieszanych jednostkach albo ręcznej ilości sumowane są ilości policzone per kod.
- **M5:** budowa treści zapisu i klucza idempotencji to czyste funkcje (`payload.ts`: `buildImportPayload`, `requestIdFor`) z testami.
- **L1:** po udanym zapisie przycisk pozostaje zablokowany (przekierowanie w toku).
- **L2:** wiersz z samym kodem (bez ilości i jednostki) jest grupą tylko wtedy, gdy NIE wygląda jak kod elementu (WIELKIE litery/cyfry/`. _ / -`, pojedyncze spacje); inaczej błąd z numerem wiersza. Skutek uboczny: nazwa grupy zapisana wyłącznie wielkimi literami zostałaby uznana za kod — LiczOkno nazywa grupy zwykłym tekstem („Okucia”).
- **L3:** wiersze, których kod pasuje do `/^razem\b/i`, są pomijane.
- **L5:** przycinanie tekstów (odwołania, nazwy, komunikaty) po code pointach, nie po jednostkach UTF-16.
- **L6:** rdzeń zapisuje `raw_source_ref` wyłącznie dla źródła IMPORT; `create_requirement` (MANUAL) go ignoruje.
- **L7:** po ręcznej zmianie ilości pozycja ma status „Ręcznie” (`RECZNIE`, gotowa), a przeliczenie pokazuje się jako „proponowano: …”; ręczna wartość równa propozycji nie jest zmianą ręczną.
- **L9:** „Zapamiętaj powiązanie” jest odznaczone i zablokowane (z wyjaśnieniem), gdy kod z pliku nie spełnia formatu kodu materiału — wskazanie obowiązuje wtedy tylko w tym imporcie.
- **L11:** SheetJS pochodzi z oficjalnego CDN (`cdn.sheetjs.com`), więc `pnpm install` / build wymagają do niego dostępu, a aktualizacje trzeba sprawdzać ręcznie (brak wpisu w rejestrze npm → brak automatycznych alertów o podatnościach).
