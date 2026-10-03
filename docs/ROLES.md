# Role

## ADMIN

Pełny dostęp:
- materiały
- lokalizacje
- użytkownicy
- ruchy
- korekty
- ustawienia
- podgląd wszystkiego

## BIURO

- materiały — podgląd
- magazyn — podgląd
- zlecenia
- zapotrzebowania
- import LiczOkno
- analiza braków
- dostawcy
- brak ręcznych korekt stocku

## PRODUKCJA

- podgląd materiałów
- skanowanie lokalizacji
- przyjęcia
- wydania
- przesunięcia
- operacje magazynowe powiązane ze zleceniami

Uprawnienia muszą być egzekwowane po stronie backendu, nie tylko przez ukrywanie przycisków.

## Uwagi techniczne (Etap 4, ADR 009)

- Historia ruchów: ADMIN i BIURO widzą wszystkie operacje i ruchy; PRODUKCJA — wyłącznie własne (RLS + `list_stock_movements`). Stany (`stock`, `v_stock`) widzą wszyscy aktywni.
- Konta, które wykonały jakąkolwiek operację magazynową, tylko **dezaktywujemy**. Usunięcie konta blokuje klucz obcy `stock_operations/stock_movements.user_id → profiles` — celowo, żeby historia zawsze wskazywała autora.

## Uwagi techniczne (Etap 5, ADR 010)

- Zlecenia: tworzą, edytują i zmieniają status BIURO i ADMIN; wszyscy aktywni czytają (PRODUKCJA wybiera otwarte zlecenie przy wydaniu). Zleceń nie usuwamy.
- Wydania i przesunięcia: PRODUKCJA i ADMIN (terminal; ADMIN także formularze na desktopie). BIURO ogląda listy „Wydania”/„Przesunięcia”.

## Uwagi techniczne (Etap 6, ADR 011)

- Korekta stanu i cofnięcie operacji (storno): wyłącznie ADMIN (route handler i funkcja DB; BIURO/PRODUKCJA → 403/42501). Na terminalu przycisk „Koryguj” widzi tylko ADMIN.
- Historia ruchów `/historia`: ADMIN i BIURO (wszystkie operacje); PRODUKCJA — tylko własne przez API i „Moje ostatnie operacje” na terminalu. Kontrola spójności stanów — ADMIN.

## Uwagi techniczne (Etap 8–10, ADR 013)

- Listy zapotrzebowania zlecenia: tworzą i wycofują BIURO i ADMIN (funkcje DB); czytają wszyscy aktywni. Braki (strona „Braki”, eksport CSV, braki zlecenia): BIURO, ADMIN. Terminal („Do wydania na to zlecenie”): PRODUKCJA, ADMIN.

## Uwagi techniczne (Etap 11, ADR 014)

- Rezerwacje: tworzą i zwalniają BIURO i ADMIN (funkcje DB; PRODUKCJA → 403/42501). Dostępność z rezerwacjami widzą wszyscy aktywni.
- Wydanie mimo rezerwacji innych zleceń (override z powodem): wyłącznie ADMIN (route handler 403 + funkcja DB 42501).

## Uwagi techniczne (Etap 13, ADR 015)

- Inwentaryzacja: sesje tworzą, zamykają i anulują BIURO i ADMIN. Liczą PRODUKCJA i ADMIN (terminal) — „na ślepo”: ekran liczenia i API inwentaryzacji nie pokazują liczącemu stanu systemowego ani różnic (pozostałe ekrany terminala nadal pokazują stany — RLS na `stock` bez zmian).
- **Świadomy wyjątek od „BIURO — brak ręcznych korekt stocku”**: różnice inwentaryzacji zatwierdza BIURO lub ADMIN (decyzja użytkownika 2026-10-03). Każda zatwierdzona różnica to ruch `INVENTORY` w historii z użytkownikiem zatwierdzającym i powiązaniem z sesją; zgodne pozycje bez ruchu. Ręczna korekta (`stock_adjust`) i storno (w tym operacji INVENTORY) nadal wyłącznie ADMIN.
