# ADR 008 — Lokalizacje i kody QR

## Uprawnienia

| | odczyt | zapis (insert/update) | etykiety (zaznaczanie, druk) |
|---|---|---|---|
| `locations` | każdy aktywny użytkownik | ADMIN | ADMIN, BIURO |

RLS jak w ADR 007 (`(select app.user_role())`), dodatkowo trigger `app.locations_before_write` odrzuca zapis (42501) roli `authenticated` innej niż ADMIN przed RLS. Brak DELETE (lokalizacje dezaktywujemy: `active = false`) — w Etapie 4 stock będzie wskazywał `location_id`. Audyt `created_*/updated_*` ustawia baza (`app.catalog_set_audit`). Kolejność triggerów BEFORE (PostgreSQL odpala je alfabetycznie): `locations_a_guard_normalize` (kontrola roli + normalizacja), potem `locations_b_audit` (migracja `20261001190000`).

## Format kodu

`^[A-Z0-9._-]{1,20}$` i co najmniej jedna litera/cyfra; **bez spacji i bez `/`** (kod jest drukowany na etykiecie i skanowany; `/` rozbijał trasy URL, a pierwotne 30 znaków nie mieściło się czytelnie na etykiecie 3×8). Normalizacja: trim + UPPERCASE (trigger i zod), więc `unique (code)` jest niezależne od wielkości liter. CHECK zmieniono migracją `20261001190000` (tabela była pusta). Wzorzec seryjny: `REGAŁ-PÓŁKA-POZIOM` (`A-03-02`); regał 1–10 znaków `[A-Z0-9]`, numery 1–999; zera wiodące do liczby cyfr maksimum zakresu (min. 2), osobno dla półek i poziomów, więc kody sortują się poprawnie (najdłuższy możliwy kod: 18 znaków).

Kod można zmienić (ADMIN) — UI ostrzega, że trzeba wydrukować nową etykietę; stock (Etap 4) wskazuje po `id`, więc dane się nie zrywają.

## Trasy i kodowanie

`/m/lokalizacje/[code]` i `/api/v1/locations/by-code/[code]` — zwykły segment; link = `encodeURIComponent(code)`, strona/handler dekodują `decodeCodeParam` (try/catch). **Uwaga:** Next.js sam dekoduje parametr i dla niepoprawnego kodowania procentowego (`%E0%A4%A`) zwraca 500 (`DecodeError`) zanim zadziała handler/strona — dlatego `middleware.ts` (po sprawdzeniu sesji) odpowiada na takie ścieżki 404 `UNKNOWN_CODE` (API) lub przepisuje stronę na ekran „Nieznany kod lokalizacji”. Pokryte testami middleware.

## API

`GET /api/v1/locations` (`q`, `includeInactive`, `page`, `pageSize` ≤ 100), `GET /[id]`, `POST`, `PATCH /[id]`, `POST /bulk`, `GET /by-code/[code]`.
- `by-code`: nieznany lub niepoprawny kod → 404 `UNKNOWN_CODE` („Nieznany kod lokalizacji”); nieaktywna → 200 z `active:false`. Prefiks `L:` zdejmuje klient (`parseScannedCode`), API przyjmuje sam kod.
- `POST /bulk` (ADMIN, 1–200): **jeden wielowierszowy INSERT = jedna transakcja** — wszystkie albo żadna. Duplikaty na liście → 400; kod już w bazie → 409 `CODE_TAKEN` z `fields.codes` (lista zajętych; odczyt informacyjny po nieudanym zapisie). Równoległe bulki z tym samym kodem: wygrywa jeden (test DB).

## Zawartość QR

QR zawiera **`L:<kod>`** (np. `L:A-03-02`), na etykiecie drukujemy sam kod. Dwukropek nie należy do alfabetu kodów lokalizacji ani materiałów, więc prefiks jednoznacznie odróżnia typy kodów w przyszłości (np. `M:` dla materiałów) bez przebudowy workflow. Bez URL — etykieta nie zależy od domeny. `parseScannedCode` akceptuje `L:<kod>` (preferowane) oraz sam kod (ręczny wpis, zgodność); inny prefiks, URL, pusty lub za długi tekst → „To nie jest kod lokalizacji”. Korekcja błędów **Q** (~25%) — etykiety w hali się brudzą. **Code 128 (kod kreskowy) nie jest obsługiwany w MVP** — tylko QR; skaner (`qr-scanner`) nie czyta kodów liniowych.

## Biblioteki

- **`qrcode-generator` 2.0.4** (MIT, brak zależności, ~20 kB) — generowanie QR **w przeglądarce** na stronie etykiet; własny `<svg>` ze ścieżki modułów (bez `innerHTML`), quiet zone 4 moduły. Dynamiczny import w `useEffect`.
- **`qr-scanner` 1.4.2** (nimiq, MIT; zależność tylko od typów `@types/offscreencanvas`) — natywny `BarcodeDetector`, gdy dostępny; w pozostałych przypadkach własny worker (działa na iOS Safari). `import()` wyłącznie na `/m/skanuj`.
- **Obszar analizy skanera:** domyślnie biblioteka analizuje 2/3 kadru zmniejszone do 400 px, co jest za mało dla małej etykiety (moduł ≈ 1 mm). Ustawiono `calculateScanRegion`: 80% krótszego boku kadru, `downScaledWidth/Height = 640` (≈ 2× więcej pikseli na moduł; przy 8 skanach/s koszt CPU nadal niewielki). Wartości do skorygowania po próbie na realnym telefonie.
- **Poza Workerem:** webpack generuje chunki SSR także dla dynamicznych importów w komponentach klienckich, a OpenNext wkleja je do Workera — dlatego w `next.config.ts` (`webpack`, tylko build serwerowy) aliasy `qr-scanner` i `qrcode-generator` wskazują pusty moduł (`false`). Pomiar: Worker 1433 → 1477 KiB gzip (nowe trasy/strony; biblioteki QR: 0 trafień w `handler.mjs`).

## Druk etykiet

`/lokalizacje/etykiety?ids=…` (ADMIN, BIURO; do 200 id): A4 bez marginesów (`@page { size: A4; margin: 0 }`), rozmiary **3×8** (70×37 mm, 24/arkusz; QR 33 mm na niemal pełną wysokość, moduł ≈ 1 mm) lub **2×5** (105×57 mm, 10/arkusz; QR 45 mm); QR + duży kod + nazwa, przerywana ramka jako linia cięcia; `print:hidden` chowa nawigację i sterowanie. Napis kodu ma minimalną czcionkę 4,2 mm (≈ 3 mm wysokości znaku) — dłuższe kody zawijają się w kilka linii zamiast się zmniejszać. Przeglądarka musi drukować w skali 100%, bez nagłówków/stopek.

**Zalecenia:** etykieta **2×5** jest lepsza do skanowania z większej odległości (np. z wózka, półki wysoko); 3×8 nadaje się do bliskiego skanowania. **Przed wydrukiem całości zrobić wydruk próbny** i sprawdzić skanowanie telefonem pracowników w warunkach hali (oświetlenie, odległość, zabrudzenie).

## Terminal mobilny

`/m/skanuj`: kamera (tylna, 8 skanów/s), zawsze dostępne ręczne wpisanie kodu; po odczycie wibracja (jeśli jest), zatrzymanie kamery i przejście na `/m/lokalizacje/[kod]`; flaga `handled` chroni przed wielokrotnym odczytem tej samej klatki; odmowa zgody/brak kamery/brak HTTPS → czytelny komunikat. Kamera wymaga HTTPS (workers.dev i localhost są OK). `/m/lokalizacje`: duże pole wyszukiwania + wysokie, dotykowe wiersze (max 100 wyników). `/m/lokalizacje/[kod]`: sekcja „Zawartość” czeka na Etap 4; PRZYJĘCIE/WYDANIE nieaktywne („wkrótce”).

## CSP

Obecna CSP to tylko `frame-ancestors 'none'`. Gdyby dodać pełną CSP, skaner wymaga m.in. `worker-src blob:` i `media-src` dla strumienia kamery (komentarz w `src/lib/security-headers.ts`).
