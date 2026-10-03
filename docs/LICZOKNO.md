# Integracja z LiczOkno

Na początku brak bezpośredniej integracji API.

Źródłem zapotrzebowania będą pliki Excel/CSV.

Użytkownik ma kilka różnych wzorów plików i dostarczy je później.

## Projektowanie

Nie kodować parsera na sztywno bez przykładowego pliku.

Docelowo:

Import file
→ wykrycie / wybór formatu
→ normalizacja
→ material mapping
→ requirement
→ stock comparison

Parser powinien być oddzielony od domeny magazynowej.

Nie wolno dopuścić, żeby specyfika jednego Excela przeniknęła do tabel magazynowych.

## Stan (Etap 12a, ADR 016)

Zaimplementowany jest import formatu **„Lista materiałowa”** (id `liczokno-lista-materialowa`). Plik jest parsowany wyłącznie w przeglądarce (moduł `src/modules/liczokno-import/`, SheetJS ładowany dynamicznie); na serwer trafia znormalizowany JSON. Szczegóły, decyzje i API: `docs/decisions/016-liczokno-import.md`.

### Format „Lista materiałowa” (arkusz .xls / .xlsx / .csv)

- Wiersz tytułowy (przed nagłówkiem): `Zlecenie: <nazwa>   Utworzono: <dd.mm.rrrr>` — nazwa i data w jednej komórce, rozdzielone wieloma spacjami. Nazwa jest podpowiedzią nazwy zlecenia (do edycji).
- Wiersz nagłówka (szukany w pierwszych ~20 wierszach, kolumny po NAZWACH): `Kod elementu`, `Nr GM Systemowy`, `Opis`, `Ilość`, `Jednostka miary`, `Cena jedn. PLN`, `Wartość PLN`. Wymagane: Kod elementu, Ilość, Jednostka miary (Opis opcjonalny). Ceny i wartości są ignorowane.
- Grupy: wiersz z samym kodem w pierwszej kolumnie (np. „Akcesoria systemowe”, „Okucia”, „Profile …”); pozycje pod nim należą do tej grupy. Grupa zaczynająca się od „Profile” (bez względu na wielkość liter) oznacza profile.
- Pozycje: kod, opis, ilość (liczba albo tekst z przecinkiem dziesiętnym), jednostka (`szt.`, `m`). Ten sam kod może wystąpić w wielu wierszach — ilości są sumowane (po normalizacji kodu). Profile są w metrach.
- Pomijane: wiersze „Razem:”, puste, „Razem wartość materiału…”; parsowanie kończy się na tabeli „GRUPA RABATOWA …”.
- Wiersz z kodem bez poprawnej ilości (brak, tekst, ≤ 0) albo bez jednostki to błąd parsowania z numerem wiersza — pozycje nie są po cichu pomijane.

### Jak dodać nowy format

1. Utwórz plik w `src/modules/liczokno-import/formats/` (np. `inny-format.ts`) eksportujący obiekt `ImportFormat` (`id`, `label`, `detect(rows)`, `parse(rows)`; typy w `types.ts`). `rows` to arkusz jako `unknown[][]`; `detect` ma rozpoznawać układ po ZAWARTOŚCI (nagłówki), nie po nazwie pliku; `parse` zwraca `ParsedImport` (jedna `ParsedLine` na wiersz źródła z numerem wiersza) albo rzuca `ImportParseError` z czytelnym komunikatem i numerem wiersza.
2. Dopisz format do `IMPORT_FORMATS` w `formats/index.ts` (pierwszy pasujący `detect` wygrywa — nie rób go zbyt szerokiego).
3. Dodaj testy w `tests/unit/` na tablicach wierszy zbudowanych w teście (zanonimizowane dane, bez nazwisk klientów i cen) oraz — jeśli masz prawdziwy plik w `docs/przykladowy_wzor/` (poza gitem) — test z `describe.skipIf(!existsSync(...))`.
4. Reszta (sumowanie po kodzie, jednostki, przeliczanie sztang, dopasowanie kodów, powiązania, podgląd, zapis) działa bez zmian — korzysta wyłącznie z `ParsedImport`. Nie zmieniaj tabel domeny pod specyfikę pliku; źródło pozycji zapisuje `raw_source_ref` (≤ 200 znaków).
