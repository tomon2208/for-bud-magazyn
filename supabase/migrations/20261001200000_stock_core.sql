-- Etap 4: rdzeń stocku + przyjęcia (ADR 009).
-- Migracja addytywna: nowe tabele/funkcje/polityki/triggery + kolumna materials.allows_fraction
-- (wypełniona dla istniejących wierszy wg jednostki). Żadnych DROP danych.
--
-- Zasady (ADR 002, docs/PLAN.md sekcja A):
-- * stan bieżący (stock) zmieniają WYŁĄCZNIE funkcje stockowe (SECURITY DEFINER), zawsze razem z ruchem,
-- * ruchy (stock_movements) i nagłówki operacji (stock_operations) są niemutowalne (trigger),
-- * authenticated/anon/service_role nie mają INSERT/UPDATE/DELETE na tabelach stockowych,
-- * każda funkcja: rola → idempotencja (client_request_id) → blokada materiału FOR UPDATE → walidacja → zapis.

-- ---------------------------------------------------------------------------
-- 1. materials.allows_fraction
-- ---------------------------------------------------------------------------
-- Jednostki liczone w sztukach: ilości całkowite. Wielkość liter i kropka bez znaczenia.
create function app.unit_allows_fraction(p_unit text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select lower(btrim(coalesce(p_unit, ''))) not in (
    'szt', 'szt.', 'sztuka', 'sztanga', 'opak', 'opak.', 'opakowanie'
  )
$$;

revoke all on function app.unit_allows_fraction(text) from public, anon, authenticated, service_role;

alter table public.materials add column allows_fraction boolean;
-- Wypełnienie istniejących wierszy bez triggerów audytu/normalizacji: to zmiana schematu, nie edycja
-- użytkownika — updated_at/updated_by zostają bez zmian.
alter table public.materials disable trigger materials_audit;
alter table public.materials disable trigger materials_normalize;
update public.materials set allows_fraction = app.unit_allows_fraction(unit);
alter table public.materials enable trigger materials_audit;
alter table public.materials enable trigger materials_normalize;
alter table public.materials alter column allows_fraction set not null;

comment on column public.materials.allows_fraction is
  'Czy ilości mogą być ułamkowe (max 3 miejsca). Domyślnie wg jednostki (szt./sztanga/opak. → false). Zablokowane po pierwszym ruchu.';

-- ---------------------------------------------------------------------------
-- 2. Tabele stockowe
-- ---------------------------------------------------------------------------
create table public.stock_operations (
  id uuid primary key default gen_random_uuid(),
  type text not null
    constraint stock_operations_type_valid check (type in ('RECEIPT', 'ISSUE', 'TRANSFER', 'ADJUSTMENT', 'INVENTORY')),
  user_id uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  client_request_id uuid not null
    constraint stock_operations_client_request_id_key unique,
  -- FK do production_orders dodamy w Etapie 8 (tabela zleceń jeszcze nie istnieje).
  production_order_id uuid,
  supplier_id uuid references public.suppliers (id),
  document_ref text
    constraint stock_operations_document_ref_valid check (document_ref is null or (document_ref = btrim(document_ref) and length(document_ref) between 1 and 100)),
  reason text
    constraint stock_operations_reason_valid check (reason is null or (reason = btrim(reason) and length(reason) between 1 and 500)),
  note text
    constraint stock_operations_note_valid check (note is null or (note = btrim(note) and length(note) between 1 and 500))
);

create index stock_operations_type_created_idx on public.stock_operations (type, created_at desc);
create index stock_operations_user_created_idx on public.stock_operations (user_id, created_at desc);
create index stock_operations_supplier_idx on public.stock_operations (supplier_id) where supplier_id is not null;

create table public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references public.stock_operations (id),
  material_id uuid not null references public.materials (id),
  location_id uuid not null references public.locations (id),
  quantity_delta numeric(12, 3) not null
    constraint stock_movements_delta_nonzero check (quantity_delta <> 0),
  user_id uuid not null references public.profiles (id),
  created_at timestamptz not null default now()
);

create index stock_movements_material_created_idx on public.stock_movements (material_id, created_at desc);
create index stock_movements_location_created_idx on public.stock_movements (location_id, created_at desc);
create index stock_movements_operation_idx on public.stock_movements (operation_id);

-- Stan bieżący. Wiersze z quantity = 0 zostają (nie usuwamy) — ADR 009.
create table public.stock (
  material_id uuid not null references public.materials (id),
  location_id uuid not null references public.locations (id),
  quantity numeric(12, 3) not null
    constraint stock_quantity_nonnegative check (quantity >= 0),
  updated_at timestamptz not null default now(),
  primary key (material_id, location_id)
);

create index stock_location_idx on public.stock (location_id);

comment on table public.stock_operations is 'Nagłówki operacji magazynowych (niemutowalne). Jedno żądanie = jeden client_request_id.';
comment on table public.stock_movements is 'Ruchy magazynowe (niemutowalne, delta ze znakiem). Źródło prawdy historii stocku.';
comment on table public.stock is 'Stan bieżący (materiał × lokalizacja). Zmieniany wyłącznie przez funkcje stockowe razem z ruchem.';

-- ---------------------------------------------------------------------------
-- 3. Niemutowalność historii + sprzątanie danych testowych
-- ---------------------------------------------------------------------------
-- UPDATE zawsze zabroniony. DELETE wyłącznie wewnątrz public.purge_test_stock() (flaga transakcyjna
-- forbud.purge_test ustawiana tylko przez tę funkcję) i wyłącznie dla materiałów z kodem 'TEST-%'.
-- Klient Data API (anon/authenticated/service_role) nie może ustawić tej flagi — nie wykonuje dowolnego SQL,
-- a set_config nie jest wystawione w API. Dodatkowo żadna z tych ról nie ma uprawnienia DELETE.
create function app.stock_history_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and current_setting('forbud.purge_test', true) = 'on' then
    if tg_table_name = 'stock_movements' then
      if exists (select 1 from public.materials m where m.id = old.material_id and m.code like 'TEST-%') then
        return old;
      end if;
    elsif tg_table_name = 'stock_operations' then
      if not exists (select 1 from public.stock_movements mv where mv.operation_id = old.id) then
        return old;
      end if;
    end if;
  end if;
  raise exception 'Historia ruchów magazynowych jest niemutowalna — błędy koryguje się kolejnym ruchem'
    using errcode = 'P0001', hint = 'IMMUTABLE';
end;
$$;

create function app.stock_history_no_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Historia ruchów magazynowych jest niemutowalna' using errcode = 'P0001', hint = 'IMMUTABLE';
end;
$$;

revoke all on function app.stock_history_immutable() from public, anon, authenticated, service_role;
revoke all on function app.stock_history_no_truncate() from public, anon, authenticated, service_role;

create trigger stock_operations_immutable
  before update or delete on public.stock_operations
  for each row execute function app.stock_history_immutable();
create trigger stock_movements_immutable
  before update or delete on public.stock_movements
  for each row execute function app.stock_history_immutable();
create trigger stock_operations_no_truncate
  before truncate on public.stock_operations
  for each statement execute function app.stock_history_no_truncate();
create trigger stock_movements_no_truncate
  before truncate on public.stock_movements
  for each statement execute function app.stock_history_no_truncate();

-- Stan bieżący: zapis tylko z funkcji stockowych (flaga forbud.stock_write) albo ze sprzątania testów.
-- Chroni przed „magicznym” poprawianiem stanu bez ruchu także ścieżkami uprzywilejowanymi (SQL Editor itp.).
create function app.stock_guard_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'Stanu magazynowego nie zmienia się bez ruchu' using errcode = 'P0001', hint = 'IMMUTABLE';
  end if;
  if current_setting('forbud.stock_write', true) = 'on' then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' and current_setting('forbud.purge_test', true) = 'on' then
    return old;
  end if;
  raise exception 'Stan magazynowy zmieniają wyłącznie operacje magazynowe (z ruchem w historii)'
    using errcode = 'P0001', hint = 'IMMUTABLE';
end;
$$;

revoke all on function app.stock_guard_write() from public, anon, authenticated, service_role;

create trigger stock_guard_write
  before insert or update or delete on public.stock
  for each row execute function app.stock_guard_write();
create trigger stock_guard_truncate
  before truncate on public.stock
  for each statement execute function app.stock_guard_write();

-- Sprzątanie danych testowych (pnpm test:db, smoke). EXECUTE tylko service_role (klucz secret).
-- Usuwa stany, ruchy i operacje WYŁĄCZNIE materiałów z kodem '<prefiks>-%', gdzie prefiks = 'TEST-<runId>'
-- (albo samo 'TEST' — wszystkie pozostałości testów). Operacja mieszająca materiał testowy z nietestowym
-- przerywa sprzątanie (nic nie zostaje usunięte). Przed startem produkcyjnym funkcję należy usunąć (ADR 009).
create function public.purge_test_stock(p_code_prefix text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pattern text;
  v_ops uuid[];
  v_deleted integer;
begin
  if p_code_prefix is null or p_code_prefix !~ '^TEST(-[A-Z0-9]{4,20})?$' then
    raise exception 'Prefiks musi mieć postać TEST albo TEST-<runId>' using errcode = '22023';
  end if;
  v_pattern := p_code_prefix || '-%';

  select coalesce(array_agg(distinct mv.operation_id), '{}') into v_ops
  from public.stock_movements mv
  join public.materials m on m.id = mv.material_id
  where m.code like v_pattern;

  if exists (
    select 1
    from public.stock_movements mv
    join public.materials m on m.id = mv.material_id
    where mv.operation_id = any (v_ops)
      and m.code not like v_pattern
  ) then
    raise exception 'Operacja obejmuje materiał spoza danych testowych — przerwano' using errcode = 'P0001';
  end if;

  perform set_config('forbud.purge_test', 'on', true);

  delete from public.stock_movements mv
  using public.materials m
  where m.id = mv.material_id and m.code like v_pattern;
  get diagnostics v_deleted = row_count;

  delete from public.stock_operations o where o.id = any (v_ops);

  delete from public.stock s
  using public.materials m
  where m.id = s.material_id and m.code like v_pattern;

  perform set_config('forbud.purge_test', '', true);
  return v_deleted;
end;
$$;

revoke all on function public.purge_test_stock(text) from public, anon, authenticated, service_role;
grant execute on function public.purge_test_stock(text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Uprawnienia i RLS: tylko odczyt dla aktywnych użytkowników
-- ---------------------------------------------------------------------------
alter table public.stock_operations enable row level security;
alter table public.stock_movements enable row level security;
alter table public.stock enable row level security;

revoke all on table public.stock_operations, public.stock_movements, public.stock
  from public, anon, authenticated, service_role;
grant select on table public.stock_operations, public.stock_movements, public.stock to authenticated, service_role;

create policy stock_operations_select on public.stock_operations
  for select to authenticated
  using ((select app.user_role()) is not null);
create policy stock_movements_select on public.stock_movements
  for select to authenticated
  using ((select app.user_role()) is not null);
create policy stock_select on public.stock
  for select to authenticated
  using ((select app.user_role()) is not null);

-- ---------------------------------------------------------------------------
-- 5. Blokady kartoteki
-- ---------------------------------------------------------------------------
-- Materiał: allows_fraction domyślnie wg jednostki (INSERT bez wartości); zmiana unit/allows_fraction
-- zablokowana po pierwszym ruchu (UNIT_LOCKED); dezaktywacja zablokowana, gdy stan ≠ 0 (HAS_STOCK).
-- Nazwa z prefiksem „z”: BEFORE triggery odpalane alfabetycznie — ten działa po materials_normalize
-- (kontrola roli + normalizacja jednostki), więc porównuje już znormalizowane wartości.
-- Współbieżność: UPDATE materiału blokuje jego wiersz, a stock_receipt robi SELECT … FOR UPDATE na tym
-- samym wierszu — przyjęcie i zmiana kartoteki są serializowane; zapytania w triggerze (READ COMMITTED,
-- funkcja VOLATILE) widzą stan zatwierdzony przez wcześniejszą transakcję.
create function app.materials_stock_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.allows_fraction is null then
      new.allows_fraction := app.unit_allows_fraction(new.unit);
    end if;
    return new;
  end if;

  if new.unit is distinct from old.unit or new.allows_fraction is distinct from old.allows_fraction then
    if exists (select 1 from public.stock_movements mv where mv.material_id = old.id) then
      raise exception 'Nie można zmienić jednostki ani ułamkowości materiału, który ma ruchy magazynowe'
        using errcode = 'P0001', hint = 'UNIT_LOCKED';
    end if;
  end if;

  if old.active and not new.active then
    if exists (select 1 from public.stock s where s.material_id = old.id and s.quantity <> 0) then
      raise exception 'Nie można dezaktywować materiału, który jest na stanie'
        using errcode = 'P0001', hint = 'HAS_STOCK';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function app.materials_stock_guard() from public, anon, authenticated, service_role;

create trigger materials_z_stock_guard
  before insert or update on public.materials
  for each row execute function app.materials_stock_guard();

-- Lokalizacja: dezaktywacja tylko pustej (LOCATION_NOT_EMPTY). UPDATE blokuje wiersz lokalizacji
-- (FOR NO KEY UPDATE), co koliduje z FOR SHARE zakładanym przez stock_receipt — patrz ADR 009.
create function app.locations_stock_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.active and not new.active then
    if exists (select 1 from public.stock s where s.location_id = old.id and s.quantity <> 0) then
      raise exception 'Nie można dezaktywować lokalizacji, w której jest towar'
        using errcode = 'P0001', hint = 'LOCATION_NOT_EMPTY';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function app.locations_stock_guard() from public, anon, authenticated, service_role;

create trigger locations_c_stock_guard
  before update on public.locations
  for each row execute function app.locations_stock_guard();

-- ---------------------------------------------------------------------------
-- 6. Przyjęcie: public.stock_receipt
-- ---------------------------------------------------------------------------
create function public.stock_receipt(
  p_client_request_id uuid,
  p_location_id uuid,
  p_material_id uuid,
  p_quantity numeric,
  p_supplier_id uuid default null,
  p_document_ref text default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role public.app_role := app.user_role();
  v_doc text := nullif(btrim(p_document_ref), '');
  v_note text := nullif(btrim(p_note), '');
  v_op public.stock_operations%rowtype;
  v_mv public.stock_movements%rowtype;
  v_material record;
  v_location record;
  v_supplier_active boolean;
  v_new_qty numeric;
begin
  -- 1. Rola
  if v_uid is null or v_role is null or v_role not in ('PRODUKCJA', 'ADMIN') then
    raise exception 'Brak uprawnień do przyjęcia towaru' using errcode = '42501';
  end if;
  if p_client_request_id is null then
    raise exception 'Brak identyfikatora żądania' using errcode = 'P0001', hint = 'VALIDATION';
  end if;

  -- 2. Idempotencja. Blokada advisory na client_request_id serializuje równoległe żądania z tym samym id;
  -- drugie po uzyskaniu blokady (READ COMMITTED → nowy snapshot) widzi zatwierdzoną operację pierwszego.
  -- unique(client_request_id) jest ostatnią barierą (np. przy REPEATABLE READ → 23505, nie duplikat).
  perform pg_advisory_xact_lock(hashtextextended('forbud.stock_op:' || p_client_request_id::text, 0));

  select * into v_op from public.stock_operations o where o.client_request_id = p_client_request_id;
  if found then
    select * into v_mv from public.stock_movements mv where mv.operation_id = v_op.id order by mv.id limit 1;
    if v_op.user_id <> v_uid
       or v_op.type <> 'RECEIPT'
       or v_mv.material_id is distinct from p_material_id
       or v_mv.location_id is distinct from p_location_id
       or v_mv.quantity_delta is distinct from p_quantity
       or v_op.supplier_id is distinct from p_supplier_id
       or v_op.document_ref is distinct from v_doc
       or v_op.note is distinct from v_note then
      raise exception 'Ten identyfikator żądania został już użyty dla innej operacji'
        using errcode = 'P0001', hint = 'IDEMPOTENCY_CONFLICT';
    end if;
    select s.quantity into v_new_qty
    from public.stock s
    where s.material_id = v_mv.material_id and s.location_id = v_mv.location_id;
    return jsonb_build_object(
      'operation_id', v_op.id,
      'movement_id', v_mv.id,
      'material_id', v_mv.material_id,
      'location_id', v_mv.location_id,
      'quantity', v_mv.quantity_delta,
      'new_location_quantity', coalesce(v_new_qty, 0),
      'idempotent_replay', true
    );
  end if;

  -- 3. Blokady i aktywność. Materiał FOR UPDATE — serializuje wszystkie operacje na materiale
  -- (wzorzec dla wydań, przesunięć, rezerwacji). Lokalizacja i dostawca FOR SHARE — równoległa
  -- dezaktywacja czeka na koniec tej transakcji (albo ta widzi już nieaktywny wiersz).
  select m.id, m.active, m.allows_fraction into v_material
  from public.materials m
  where m.id = p_material_id
  for update;
  if not found then
    raise exception 'Nie znaleziono materiału' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'material';
  end if;
  if not v_material.active then
    raise exception 'Materiał jest nieaktywny' using errcode = 'P0001', hint = 'MATERIAL_INACTIVE';
  end if;

  select l.id, l.active into v_location
  from public.locations l
  where l.id = p_location_id
  for share;
  if not found then
    raise exception 'Nie znaleziono lokalizacji' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'location';
  end if;
  if not v_location.active then
    raise exception 'Lokalizacja jest nieaktywna' using errcode = 'P0001', hint = 'LOCATION_INACTIVE';
  end if;

  if p_supplier_id is not null then
    select s.active into v_supplier_active
    from public.suppliers s
    where s.id = p_supplier_id
    for share;
    if not found then
      raise exception 'Nie znaleziono dostawcy' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'supplier';
    end if;
    if not v_supplier_active then
      raise exception 'Dostawca jest nieaktywny' using errcode = 'P0001', hint = 'SUPPLIER_INACTIVE';
    end if;
  end if;

  -- 4. Walidacja ilości i tekstów
  if p_quantity is null or p_quantity <= 0 or p_quantity > 1000000 or p_quantity <> round(p_quantity, 3) then
    raise exception 'Ilość musi być większa od zera, maksymalnie 1 000 000, do 3 miejsc po przecinku'
      using errcode = 'P0001', hint = 'INVALID_QUANTITY';
  end if;
  if not v_material.allows_fraction and p_quantity <> trunc(p_quantity) then
    raise exception 'Ten materiał przyjmuje się w całych jednostkach' using errcode = 'P0001', hint = 'NOT_INTEGER';
  end if;
  if length(v_doc) > 100 or length(v_note) > 500 then
    raise exception 'Numer dokumentu do 100 znaków, notatka do 500 znaków' using errcode = 'P0001', hint = 'VALIDATION';
  end if;

  -- 5. Zapis: nagłówek + ruch + stan
  insert into public.stock_operations (type, user_id, client_request_id, supplier_id, document_ref, note)
  values ('RECEIPT', v_uid, p_client_request_id, p_supplier_id, v_doc, v_note)
  returning * into v_op;

  insert into public.stock_movements (operation_id, material_id, location_id, quantity_delta, user_id, created_at)
  values (v_op.id, p_material_id, p_location_id, p_quantity, v_uid, v_op.created_at)
  returning * into v_mv;

  perform set_config('forbud.stock_write', 'on', true);
  insert into public.stock as s (material_id, location_id, quantity, updated_at)
  values (p_material_id, p_location_id, p_quantity, now())
  on conflict (material_id, location_id)
  do update set quantity = s.quantity + excluded.quantity, updated_at = excluded.updated_at
  returning s.quantity into v_new_qty;
  perform set_config('forbud.stock_write', '', true);

  return jsonb_build_object(
    'operation_id', v_op.id,
    'movement_id', v_mv.id,
    'material_id', p_material_id,
    'location_id', p_location_id,
    'quantity', p_quantity,
    'new_location_quantity', v_new_qty,
    'idempotent_replay', false
  );
end;
$$;

revoke all on function public.stock_receipt(uuid, uuid, uuid, numeric, uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.stock_receipt(uuid, uuid, uuid, numeric, uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Kontrola spójności: stock vs suma ruchów
-- ---------------------------------------------------------------------------
-- Zwraca rozbieżności (pusty wynik = spójnie). ADMIN (authenticated) albo service_role.
-- p_material_ids — opcjonalne zawężenie (testy); NULL = cały magazyn.
create function public.verify_stock(p_material_ids uuid[] default null)
returns table (material_id uuid, location_id uuid, stock_quantity numeric, ledger_quantity numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if current_setting('role', true) is distinct from 'service_role'
     and (select app.user_role()) is distinct from 'ADMIN' then
    raise exception 'Brak uprawnień' using errcode = '42501';
  end if;

  return query
  with ledger as (
    select mv.material_id, mv.location_id, sum(mv.quantity_delta) as qty
    from public.stock_movements mv
    where p_material_ids is null or mv.material_id = any (p_material_ids)
    group by mv.material_id, mv.location_id
  ),
  cur as (
    select s.material_id, s.location_id, s.quantity as qty
    from public.stock s
    where p_material_ids is null or s.material_id = any (p_material_ids)
  )
  select coalesce(c.material_id, l.material_id),
         coalesce(c.location_id, l.location_id),
         coalesce(c.qty, 0)::numeric,
         coalesce(l.qty, 0)::numeric
  from cur c
  full join ledger l on l.material_id = c.material_id and l.location_id = c.location_id
  where coalesce(c.qty, 0) <> coalesce(l.qty, 0);
end;
$$;

revoke all on function public.verify_stock(uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.verify_stock(uuid[]) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. Odczyt: widok stanów (security_invoker → RLS tabel bazowych)
-- ---------------------------------------------------------------------------
create view public.v_stock
with (security_invoker = true)
as
select
  s.material_id,
  m.code as material_code,
  m.name as material_name,
  m.unit,
  m.allows_fraction,
  m.active as material_active,
  s.location_id,
  l.code as location_code,
  l.name as location_name,
  l.active as location_active,
  s.quantity,
  s.updated_at
from public.stock s
join public.materials m on m.id = s.material_id
join public.locations l on l.id = s.location_id;

revoke all on table public.v_stock from public, anon, authenticated, service_role;
grant select on table public.v_stock to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9. Lista ruchów z danymi operacji (desktop: Przyjęcia; później historia ruchów)
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER, bo nazwisko wykonującego jest w profiles, które BIURO widzi tylko dla siebie.
-- Zwraca wyłącznie pola potrzebne do listy (bez loginów/ról innych użytkowników). ADMIN, BIURO.
create function public.list_stock_movements(
  p_type text default null,
  p_material_q text default null,
  p_date_from date default null,
  p_date_to date default null,
  p_page integer default 1,
  p_page_size integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role public.app_role := app.user_role();
  v_pattern text;
  v_from timestamptz;
  v_to timestamptz;
  v_total bigint;
  v_items jsonb;
begin
  if v_role is null or v_role not in ('ADMIN', 'BIURO') then
    raise exception 'Brak uprawnień' using errcode = '42501';
  end if;
  if p_page is null or p_page < 1 or p_page > 100000 or p_page_size is null or p_page_size < 1 or p_page_size > 100 then
    raise exception 'Nieprawidłowa strona' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  if p_type is not null and p_type not in ('RECEIPT', 'ISSUE', 'TRANSFER', 'ADJUSTMENT', 'INVENTORY') then
    raise exception 'Nieprawidłowy typ operacji' using errcode = 'P0001', hint = 'VALIDATION';
  end if;

  if nullif(btrim(p_material_q), '') is not null then
    -- Dosłowne dopasowanie „zawiera” (escapowanie \ % _).
    v_pattern := '%' || replace(replace(replace(btrim(p_material_q), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;
  -- Daty w czasie lokalnym firmy; p_date_to włącznie.
  v_from := case when p_date_from is not null then p_date_from::timestamp at time zone 'Europe/Warsaw' end;
  v_to := case when p_date_to is not null then (p_date_to + 1)::timestamp at time zone 'Europe/Warsaw' end;

  select count(*) into v_total
  from public.stock_movements mv
  join public.stock_operations o on o.id = mv.operation_id
  join public.materials m on m.id = mv.material_id
  where (p_type is null or o.type = p_type)
    and (v_pattern is null or m.code ilike v_pattern or m.name ilike v_pattern)
    and (v_from is null or mv.created_at >= v_from)
    and (v_to is null or mv.created_at < v_to);

  select coalesce(jsonb_agg(row_data order by created_at desc, id desc), '[]'::jsonb) into v_items
  from (
    select
      mv.created_at,
      mv.id,
      jsonb_build_object(
        'movement_id', mv.id,
        'operation_id', o.id,
        'type', o.type,
        'created_at', mv.created_at,
        'quantity_delta', mv.quantity_delta,
        'material_id', m.id,
        'material_code', m.code,
        'material_name', m.name,
        'unit', m.unit,
        'location_id', l.id,
        'location_code', l.code,
        'user_name', p.full_name,
        'supplier_name', sp.name,
        'document_ref', o.document_ref,
        'note', o.note,
        'reason', o.reason
      ) as row_data
    from public.stock_movements mv
    join public.stock_operations o on o.id = mv.operation_id
    join public.materials m on m.id = mv.material_id
    join public.locations l on l.id = mv.location_id
    join public.profiles p on p.id = mv.user_id
    left join public.suppliers sp on sp.id = o.supplier_id
    where (p_type is null or o.type = p_type)
      and (v_pattern is null or m.code ilike v_pattern or m.name ilike v_pattern)
      and (v_from is null or mv.created_at >= v_from)
      and (v_to is null or mv.created_at < v_to)
    order by mv.created_at desc, mv.id desc
    limit p_page_size offset (p_page - 1) * p_page_size
  ) q;

  return jsonb_build_object('total', v_total, 'items', v_items);
end;
$$;

revoke all on function public.list_stock_movements(text, text, date, date, integer, integer) from public, anon, authenticated, service_role;
grant execute on function public.list_stock_movements(text, text, date, date, integer, integer) to authenticated;
