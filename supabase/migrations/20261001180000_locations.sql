-- Etap 3: lokalizacje magazynowe (półki/regały) identyfikowane kodem QR.
-- Uprawnienia (docs/ROLES.md, ADR 008): odczyt — każdy aktywny użytkownik; zapis (insert/update) — ADMIN.
-- Brak DELETE dla ról aplikacyjnych: lokalizacji nie usuwamy, tylko dezaktywujemy (w Etapie 4 będzie
-- na nie wskazywał stan magazynowy). DELETE ma wyłącznie service_role (sprzątanie testów).
-- Migracja addytywna: nowa tabela, funkcje i polityki; nie dotyka istniejących danych.

create table public.locations (
  id uuid primary key default gen_random_uuid(),
  -- Kod drukowany na etykiecie i skanowany: WIELKIE litery, bez spacji (normalizacja w triggerze).
  code text not null
    constraint locations_code_valid check (code ~ '^[A-Z0-9._/-]{1,30}$' and code ~ '[A-Z0-9]'),
  name text
    constraint locations_name_valid check (name is null or length(name) between 1 and 100),
  description text
    constraint locations_description_valid check (description is null or length(description) between 1 and 500),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id),
  updated_by uuid references public.profiles (id),
  constraint locations_code_key unique (code)
);

-- Normalizacja + kontrola roli. Kontrola roli jest PRZED RLS WITH CHECK (wzorzec z migracji 20261001160000):
-- użytkownik bez uprawnień dostaje 42501 na samym początku. service_role (sprzątanie testów) nie jest dotknięty.
create function app.locations_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_setting('role', true) = 'authenticated'
     and (select app.user_role()) is distinct from 'ADMIN' then
    raise exception 'Brak uprawnień do zapisu lokalizacji' using errcode = '42501';
  end if;

  new.code := upper(btrim(new.code));
  new.name := nullif(btrim(new.name), '');
  new.description := nullif(btrim(new.description), '');
  return new;
end;
$$;

revoke all on function app.locations_before_write() from public, anon, authenticated;

create trigger locations_normalize
  before insert or update on public.locations
  for each row execute function app.locations_before_write();
-- Audyt (created_*/updated_*) ustawia baza z auth.uid() — klient nie może go podrobić.
create trigger locations_audit
  before insert or update on public.locations
  for each row execute function app.catalog_set_audit();

alter table public.locations enable row level security;

revoke all on table public.locations from public, anon, authenticated;
grant select, insert, update on table public.locations to authenticated;
grant select, insert, update, delete on table public.locations to service_role;

create policy locations_select on public.locations
  for select to authenticated
  using ((select app.user_role()) is not null);
create policy locations_insert on public.locations
  for insert to authenticated
  with check ((select app.user_role()) = 'ADMIN');
create policy locations_update on public.locations
  for update to authenticated
  using ((select app.user_role()) = 'ADMIN')
  with check ((select app.user_role()) = 'ADMIN');

comment on table public.locations is 'Lokalizacje magazynowe. Kod UPPERCASE bez spacji (QR na etykiecie). Nie usuwamy — dezaktywujemy.';
