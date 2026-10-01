-- Poprawki po review Etapu 3 (ADR 008):
-- 1) kod lokalizacji bez "/" (psuł trasy URL), max 20 znaków: ^[A-Z0-9._-]{1,20}$ + co najmniej jedna litera/cyfra.
--    Tabela jest pusta w chwili migracji (sprawdzone przed wgraniem); ewentualne istniejące kody nie spełniające
--    nowego warunku zablokują ADD CONSTRAINT — wtedy migracja się nie wykona (celowo).
-- 2) czytelna kolejność triggerów (BEFORE odpalane alfabetycznie): najpierw kontrola roli + normalizacja, potem audyt.

alter table public.locations drop constraint locations_code_valid;
alter table public.locations
  add constraint locations_code_valid
  check (code ~ '^[A-Z0-9._-]{1,20}$' and code ~ '[A-Z0-9]');

drop trigger locations_normalize on public.locations;
drop trigger locations_audit on public.locations;

create trigger locations_a_guard_normalize
  before insert or update on public.locations
  for each row execute function app.locations_before_write();
create trigger locations_b_audit
  before insert or update on public.locations
  for each row execute function app.catalog_set_audit();
