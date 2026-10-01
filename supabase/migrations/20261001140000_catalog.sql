-- Etap 2: kartoteki — kategorie materiałów, dostawcy, materiały.
-- Uprawnienia (docs/ROLES.md), egzekwowane przez RLS:
--   odczyt: każdy aktywny użytkownik; zapis: kategorie i materiały — ADMIN, dostawcy — ADMIN i BIURO.
-- Brak DELETE dla wszystkich ról aplikacyjnych: kartotek nie usuwamy, tylko dezaktywujemy (active = false),
-- bo będą na nie wskazywać ruchy magazynowe i zlecenia. DELETE ma wyłącznie service_role (sprzątanie testów).
-- "Auto expose new tables" jest wyłączone — uprawnienia nadajemy jawnie.

-- ---------------------------------------------------------------------------
-- Tabele
-- ---------------------------------------------------------------------------
create table public.material_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null
    constraint material_categories_name_valid check (name = btrim(name) and length(name) between 1 and 80),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id),
  updated_by uuid references public.profiles (id)
);

create unique index material_categories_name_lower_key on public.material_categories (lower(name));

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null
    constraint suppliers_name_valid check (name = btrim(name) and length(name) between 1 and 200),
  contact_person text
    constraint suppliers_contact_person_valid check (contact_person is null or length(contact_person) between 1 and 120),
  phone text
    constraint suppliers_phone_valid check (phone is null or length(phone) between 1 and 50),
  email text
    constraint suppliers_email_valid check (email is null or length(email) between 1 and 200),
  notes text
    constraint suppliers_notes_valid check (notes is null or length(notes) between 1 and 2000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id),
  updated_by uuid references public.profiles (id)
);

create unique index suppliers_name_lower_key on public.suppliers (lower(name));

create table public.materials (
  id uuid primary key default gen_random_uuid(),
  -- Kod zapisywany WIELKIMI literami (normalizacja w triggerze) → unikalność bez rozróżniania wielkości liter.
  code text not null
    constraint materials_code_valid check (code ~ '^[A-Z0-9._/-]{1,50}$'),
  name text not null
    constraint materials_name_valid check (name = btrim(name) and length(name) between 1 and 200),
  category_id uuid not null references public.material_categories (id),
  -- Jednostka jako tekst (nie enum): jest właściwością materiału, lista może rosnąć (BUSINESS_RULES).
  unit text not null
    constraint materials_unit_valid check (unit = btrim(unit) and length(unit) between 1 and 20),
  default_supplier_id uuid references public.suppliers (id),
  active boolean not null default true,
  notes text
    constraint materials_notes_valid check (notes is null or length(notes) between 1 and 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id),
  updated_by uuid references public.profiles (id),
  constraint materials_code_key unique (code)
);

-- Klucze obce nie mają automatycznych indeksów; filtr po kategorii i dostawcy + kontrola FK przy zmianach.
create index materials_category_id_idx on public.materials (category_id);
create index materials_default_supplier_id_idx on public.materials (default_supplier_id) where default_supplier_id is not null;

-- ---------------------------------------------------------------------------
-- Triggery: normalizacja danych, audyt (created_*/updated_*), aktywność powiązań
-- ---------------------------------------------------------------------------

-- Audyt: kto i kiedy — ustawiane przez bazę, klient nie może ich podrobić.
create function app.catalog_set_audit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := new.created_at;
    new.created_by := auth.uid();
    new.updated_by := new.created_by;
  else
    if new.id <> old.id then
      raise exception 'Nie można zmienić identyfikatora' using errcode = 'check_violation';
    end if;
    new.created_at := old.created_at;
    new.created_by := old.created_by;
    new.updated_at := now();
    new.updated_by := auth.uid();
  end if;
  return new;
end;
$$;

revoke all on function app.catalog_set_audit() from public, anon, authenticated;

-- Normalizacja: przycięcie spacji, puste pola opcjonalne → NULL, kod wielkimi literami.
create function app.categories_normalize()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.name := btrim(new.name);
  return new;
end;
$$;

create function app.suppliers_normalize()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.name := btrim(new.name);
  new.contact_person := nullif(btrim(new.contact_person), '');
  new.phone := nullif(btrim(new.phone), '');
  new.email := nullif(btrim(new.email), '');
  new.notes := nullif(btrim(new.notes), '');
  return new;
end;
$$;

-- Dodatkowo: materiał nie może wskazywać NIEAKTYWNEJ kategorii/dostawcy (sprawdzane przy tworzeniu
-- i przy zmianie wskazania). SECURITY DEFINER + FOR SHARE: blokada wiersza kategorii/dostawcy do końca
-- transakcji, więc równoległa dezaktywacja nie wyprzedzi zapisu materiału bez wiedzy.
-- Nieistniejące id przepuszczamy — odrzuci je klucz obcy (23503).
create function app.materials_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_active boolean;
begin
  new.code := upper(btrim(new.code));
  new.name := btrim(new.name);
  new.unit := btrim(new.unit);
  new.notes := nullif(btrim(new.notes), '');

  if tg_op = 'INSERT' or new.category_id is distinct from old.category_id then
    select c.active into v_active
    from public.material_categories c
    where c.id = new.category_id
    for share;
    if found and not v_active then
      raise exception 'Kategoria jest nieaktywna' using errcode = 'P0001', hint = 'INACTIVE_CATEGORY';
    end if;
  end if;

  if new.default_supplier_id is not null
     and (tg_op = 'INSERT' or new.default_supplier_id is distinct from old.default_supplier_id) then
    select s.active into v_active
    from public.suppliers s
    where s.id = new.default_supplier_id
    for share;
    if found and not v_active then
      raise exception 'Dostawca jest nieaktywny' using errcode = 'P0001', hint = 'INACTIVE_SUPPLIER';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function app.categories_normalize() from public, anon, authenticated;
revoke all on function app.suppliers_normalize() from public, anon, authenticated;
revoke all on function app.materials_before_write() from public, anon, authenticated;

create trigger material_categories_normalize
  before insert or update on public.material_categories
  for each row execute function app.categories_normalize();
create trigger material_categories_audit
  before insert or update on public.material_categories
  for each row execute function app.catalog_set_audit();

create trigger suppliers_normalize
  before insert or update on public.suppliers
  for each row execute function app.suppliers_normalize();
create trigger suppliers_audit
  before insert or update on public.suppliers
  for each row execute function app.catalog_set_audit();

create trigger materials_normalize
  before insert or update on public.materials
  for each row execute function app.materials_before_write();
create trigger materials_audit
  before insert or update on public.materials
  for each row execute function app.catalog_set_audit();

-- ---------------------------------------------------------------------------
-- Uprawnienia i RLS
-- ---------------------------------------------------------------------------
alter table public.material_categories enable row level security;
alter table public.suppliers enable row level security;
alter table public.materials enable row level security;

revoke all on table public.material_categories, public.suppliers, public.materials from public, anon, authenticated;
grant select, insert, update on table public.material_categories, public.suppliers, public.materials to authenticated;
grant select, insert, update, delete on table public.material_categories, public.suppliers, public.materials to service_role;

-- Odczyt: każdy aktywny użytkownik (app.user_role() IS NULL dla nieaktywnych i niezalogowanych).
create policy material_categories_select on public.material_categories
  for select to authenticated
  using ((select app.user_role()) is not null);
create policy suppliers_select on public.suppliers
  for select to authenticated
  using ((select app.user_role()) is not null);
create policy materials_select on public.materials
  for select to authenticated
  using ((select app.user_role()) is not null);

-- Zapis: kategorie i materiały — ADMIN; dostawcy — ADMIN i BIURO. Brak polityk DELETE.
create policy material_categories_insert on public.material_categories
  for insert to authenticated
  with check ((select app.user_role()) = 'ADMIN');
create policy material_categories_update on public.material_categories
  for update to authenticated
  using ((select app.user_role()) = 'ADMIN')
  with check ((select app.user_role()) = 'ADMIN');

create policy suppliers_insert on public.suppliers
  for insert to authenticated
  with check ((select app.user_role()) in ('ADMIN', 'BIURO'));
create policy suppliers_update on public.suppliers
  for update to authenticated
  using ((select app.user_role()) in ('ADMIN', 'BIURO'))
  with check ((select app.user_role()) in ('ADMIN', 'BIURO'));

create policy materials_insert on public.materials
  for insert to authenticated
  with check ((select app.user_role()) = 'ADMIN');
create policy materials_update on public.materials
  for update to authenticated
  using ((select app.user_role()) = 'ADMIN')
  with check ((select app.user_role()) = 'ADMIN');

comment on table public.material_categories is 'Kategorie materiałów (słownik). Nie usuwamy — dezaktywujemy.';
comment on table public.suppliers is 'Dostawcy. Nie usuwamy — dezaktywujemy.';
comment on table public.materials is 'Kartoteka materiałów. Kod UPPERCASE, jednostka jako tekst. Nie usuwamy — dezaktywujemy.';

-- ---------------------------------------------------------------------------
-- Seed: kategorie MVP (idempotentnie)
-- ---------------------------------------------------------------------------
insert into public.material_categories (name)
values ('Profile'), ('Akcesoria'), ('Uszczelki'), ('Chemia')
on conflict do nothing;
