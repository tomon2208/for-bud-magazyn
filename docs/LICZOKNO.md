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
