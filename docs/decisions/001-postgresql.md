# ADR 001 — PostgreSQL

Wybrano Supabase PostgreSQL jako bazę.

Powód:
- relacyjny model danych,
- transakcje,
- constraints,
- wygodne zapytania,
- możliwość rozwoju systemu,
- dobrze pasuje do magazynu, rezerwacji i historii ruchów.

Cloudflare Workers pozostaje warstwą API/logiki.
