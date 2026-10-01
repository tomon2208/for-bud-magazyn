# Workflow magazynowy

## Przyjęcie

1. Pracownik wybiera „Przyjęcie”.
2. Skanuje kod lokalizacji.
3. Wybiera materiał.
4. Podaje ilość.
5. Zatwierdza.
6. Backend wykonuje transakcję.
7. Powstaje stock movement.
8. Stan lokalizacji się zwiększa.

## Wydanie

1. Pracownik wybiera „Wydanie”.
2. Wybiera zlecenie.
3. Wybiera materiał.
4. Skanuje lokalizację.
5. Podaje ilość.
6. Backend sprawdza dostępność.
7. Powstaje movement.
8. Stock się zmniejsza.

## Przesunięcie

Materiał może zostać przesunięty:
lokalizacja A → lokalizacja B

Powinny powstać dwa logiczne ruchy albo jedna transakcja transferowa z pełnym audytem.

## Zapotrzebowanie

1. BIURO importuje plik z LiczOkno.
2. Powstaje zlecenie / zapotrzebowanie.
3. System rozpoznaje materiały.
4. Sprawdza dostępny stock.
5. Uwzględnia rezerwacje.
6. Pokazuje:
   - potrzebne,
   - dostępne,
   - zarezerwowane,
   - brakujące.
7. BIURO może wykorzystać wynik do zamówienia u dostawcy.

Na MVP system NIE wysyła automatycznego zamówienia.
