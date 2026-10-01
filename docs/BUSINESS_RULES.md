# Reguły biznesowe FOR-BUD

## Materiały

Kategorie MVP:
- profile
- akcesoria
- uszczelki
- chemia

System ma umożliwiać dodawanie kolejnych kategorii bez przebudowy architektury.

Materiał ma:
- nazwę,
- kod wewnętrzny,
- kategorię,
- jednostkę,
- domyślnego dostawcę,
- status aktywny/nieaktywny.

## Jednostki

Jednostka jest właściwością materiału. Przykłady:
- szt.
- sztanga
- mb
- opakowanie

Nie zakładać jednej globalnej jednostki dla całego magazynu.

## Profile

Profil jest materiałem.
Na magazynie występuje jako sztanga.
Na MVP nie śledzimy długości pozostałej po cięciu.

## Lokalizacje

Materiał może znajdować się w wielu lokalizacjach.
Lokalizacja może zawierać wiele materiałów.

Każda lokalizacja ma kod QR/kreskowy.

## Ruchy

Typy minimum:
- RECEIPT — przyjęcie
- ISSUE — wydanie
- ADJUSTMENT — korekta
- TRANSFER — przesunięcie

Każdy ruch ma użytkownika i czas.

## Korekty

ADMIN może ręcznie skorygować stan.
Musi podać powód.
Korekta tworzy ruch w historii.

## Dostawcy

Materiał ma domyślnego dostawcę.
Przy konkretnym zakupie można wybrać innego.

## Zlecenia

Zlecenie identyfikowane jest nazwą, np. nazwiskiem klienta.
Nie zakładać, że nazwa jest unikalna. System powinien mieć wewnętrzny ID.

## LiczOkno

Import będzie obsługiwał Excel/CSV.
Wzory będą różne.
Parser powinien być oddzielony od logiki magazynowej.

## Braki

System ma pokazać:
wymagane - dostępne/rezerwowane = brakujące

Dokładna formuła musi uwzględniać aktywne rezerwacje.
