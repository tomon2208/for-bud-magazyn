# FOR-BUD MAGAZYN

## Cel projektu

FOR-BUD MAGAZYN to webowa aplikacja magazynowa dla firmy FOR-BUD produkującej stolarkę aluminiową.

System ma zastąpić obecny magazyn prowadzony na kartce i przede wszystkim połączyć:
LiczOkno → zapotrzebowanie materiałowe → sprawdzenie magazynu → informacja o brakach → zakup → przyjęcie → produkcja.

Nie budujemy na początku pełnego ERP. Budujemy prosty, szybki i niezawodny system magazynowy dopasowany do rzeczywistej pracy FOR-BUD.

## Stack

Docelowo:
- Frontend: Next.js + TypeScript
- UI: Tailwind CSS + shadcn/ui
- Backend/API: Cloudflare Workers
- Database: Supabase PostgreSQL
- Auth: Supabase Auth
- Hosting/edge: Cloudflare
- PWA/mobile: responsywny frontend, możliwy do zainstalowania na telefonie

Nie dodawaj nowych bibliotek bez uzasadnienia.

## Role

- ADMIN — pełny dostęp, w tym ręczne korekty stanów
- BIURO — zapotrzebowania, podgląd magazynu, braki, dostawcy
- PRODUKCJA — operacje magazynowe, przyjęcia, wydania, skanowanie lokalizacji, praca mobilna

## Główne zasady domenowe

1. Materiał ma kartotekę i może znajdować się w wielu lokalizacjach.
2. Lokalizacja jest identyfikowana kodem QR/kreskowym.
3. Na MVP kod znajduje się na lokalizacji/półce, nie na każdej sztuce materiału.
4. Przyjęcie magazynowe: skan lokalizacji → wybór/skan materiału → ilość → zatwierdzenie.
5. Wydanie: wybór zlecenia → materiał → ilość → lokalizacja → zatwierdzenie.
6. Profile aluminiowe są magazynowane jako sztangi. Na MVP sztanga jest jednostką magazynową; nie śledzimy długości pozostałej po cięciu.
7. Pozostałe materiały mogą mieć jednostki zgodne z kartoteką: szt., mb, opak., itp.
8. Materiał może mieć domyślnego dostawcę, ale przy zakupie można wskazać innego dostawcę.
9. Zlecenie ma nazwę nadawaną przez firmę, np. nazwisko klienta.
10. LiczOkno dostarcza zapotrzebowanie przez Excel/CSV. Formatów będzie kilka — parser ma być projektowany jako wymienny moduł.
11. System po imporcie porównuje zapotrzebowanie z dostępnym magazynem i pokazuje brakujące ilości.
12. System nie tworzy automatycznie zamówienia do dostawcy w MVP. Ma tylko pokazać czego brakuje.
13. Rezerwacje materiału są przewidziane w architekturze i mają chronić stock przed wykorzystaniem przez inne zlecenia.
14. Każda operacja magazynowa ma historię: kto, kiedy, materiał, ilość, lokalizacja, typ operacji i powiązane zlecenie/referencję.
15. Nie usuwamy historycznych ruchów magazynowych. Błędny ruch korygujemy kolejnym ruchem.
16. ADMIN może wykonać ręczną korektę stanu. Korekta również musi zostać zapisana w historii z powodem i użytkownikiem.
17. Stan magazynowy nie może być bez wyjaśnienia magicznie zmieniany przez kod.
18. Operacje zmieniające stock muszą być transakcyjne i odporne na równoczesne operacje dwóch użytkowników.
19. Lokalizacje mogą zawierać wiele różnych materiałów.
20. Ten sam materiał może znajdować się w wielu lokalizacjach.

## UX

Desktop:
- dashboard
- magazyn
- materiały
- lokalizacje
- zapotrzebowania
- zlecenia
- braki
- przyjęcia
- wydania
- historia ruchów
- użytkownicy/admin

Mobile:
- duży przycisk SKANUJ
- PRZYJĘCIE
- WYDANIE
- SZUKAJ
- LOKALIZACJE
- INWENTARYZACJA (gdy zostanie wdrożona)

Telefon pracownika jest terminalem magazynowym. Nie projektować mobilnego UI jako pomniejszonego desktopu.

## Agent rules

- Tech Lead planuje i pilnuje architektury.
- Implementer wykonuje zadania.
- Reviewer szuka błędów, luk bezpieczeństwa, race conditions i problemów domenowych.
- Nie przebudowuj architektury bez uzasadnienia.
- Przed dużą zmianą przeczytaj odpowiednie dokumenty z `docs/`.
- Jeśli wymaganie jest niejednoznaczne i wpływa na dane lub workflow, zapytaj zamiast zgadywać.
- Drobne decyzje implementacyjne podejmuj samodzielnie.
- Nie twórz zbędnej abstrakcji na zapas.
- Każda większa funkcja powinna mieć testy.
- Nie oznaczaj funkcji jako gotowej, jeśli nie została zweryfikowana.

## MVP

Priorytet:
1. fundament projektu i auth
2. kartoteka materiałów
3. lokalizacje i kody
4. przyjęcia
5. wydania
6. historia ruchów
7. dashboard/stany
8. zlecenia
9. zapotrzebowanie
10. porównanie zapotrzebowania z magazynem
11. rezerwacje
12. import Excel/CSV z LiczOkno
13. inwentaryzacja

Na początku NIE implementować:
- automatycznych zamówień do dostawców
- dokumentów PDF/PZ/WZ
- zaawansowanego śledzenia resztek profili
- integracji online z LiczOkno
- rozbudowanego ERP
- skomplikowanego systemu workflow

## Definition of Done

Funkcja jest gotowa, gdy:
- działa w realnym przepływie użytkownika,
- ma walidację,
- poprawnie obsługuje błędy,
- nie narusza historii stocku,
- ma testy odpowiednie do ryzyka,
- działa na desktopie i telefonie, jeśli dotyczy operacji magazynowej,
- Reviewer nie ma krytycznych uwag.
