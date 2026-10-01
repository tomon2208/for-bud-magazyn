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
