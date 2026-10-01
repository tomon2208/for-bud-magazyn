-- Poprawki po review Etapu 4 (ADR 009, sekcja „Poprawki po review”).
-- M2: materials.is_test (ustawiane tylko kluczem secret, niezmienne) zamiast dopasowania kodu 'TEST-%'
--     w sprzątaniu testów i w wyjątku triggera niemutowalności.
-- M3: allows_fraction false→true zawsze; true→false tylko gdy wszystkie ruchy są całkowite; nowe jednostki całkowite.
-- M4: PRODUKCJA czyta wyłącznie WŁASNE operacje/ruchy (RLS i list_stock_movements).
-- L4: INSERT do stock_operations/stock_movements tylko z funkcji stockowych (flaga forbud.stock_write).
-- L5: stock_receipt blokuje materiał FOR NO KEY UPDATE (nie koliduje z FOR KEY SHARE kluczy obcych).

-- ---------------------------------------------------------------------------
-- M3: lista jednostek całkowitych
-- ---------------------------------------------------------------------------
create or replace function app.unit_allows_fraction(p_unit text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select lower(btrim(coalesce(p_unit, ''))) not in (
    'szt', 'szt.', 'sztuka', 'sztanga', 'opak', 'opak.', 'opakowanie',
    'kpl', 'kpl.', 'komplet', 'para', 'rolka'
  )
$$;

-- ---------------------------------------------------------------------------
-- M2: materials.is_test
-- ---------------------------------------------------------------------------
alter table public.materials add column is_test boolean not null default false;

comment on column public.materials.is_test is
  'Materiał danych testowych (test:db, smoke). Ustawiany wyłącznie kluczem secret przy tworzeniu, potem niezmienny. Tylko takie materiały może wyczyścić purge_test_stock().';

-- Backfill allows_fraction wg nowej listy — wyłącznie materiały BEZ ruchów (bez triggerów audytu).
alter table public.materials disable trigger materials_audit;
alter table public.materials disable trigger materials_normalize;
alter table public.materials disable trigger materials_z_stock_guard;
update public.materials m
set allows_fraction = app.unit_allows_fraction(m.unit)
where m.allows_fraction is distinct from app.unit_allows_fraction(m.unit)
  and not exists (select 1 from public.stock_movements mv where mv.material_id = m.id);
alter table public.materials enable trigger materials_audit;
alter table public.materials enable trigger materials_normalize;
alter table public.materials enable trigger materials_z_stock_guard;

create or replace function app.materials_stock_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- is_test: tylko klucz secret (service_role) może utworzyć materiał testowy.
    if new.is_test and current_setting('role', true) is distinct from 'service_role' then
      raise exception 'Materiał testowy może utworzyć wyłącznie skrypt testów' using errcode = '42501';
    end if;
    if new.allows_fraction is null then
      new.allows_fraction := app.unit_allows_fraction(new.unit);
    end if;
    return new;
  end if;

  if new.is_test is distinct from old.is_test then
    raise exception 'Nie można zmienić znacznika materiału testowego' using errcode = '42501';
  end if;

  if new.unit is distinct from old.unit then
    if exists (select 1 from public.stock_movements mv where mv.material_id = old.id) then
      raise exception 'Nie można zmienić jednostki materiału, który ma ruchy magazynowe'
        using errcode = 'P0001', hint = 'UNIT_LOCKED';
    end if;
  end if;

  -- false → true zawsze dozwolone; true → false tylko gdy wszystkie dotychczasowe ruchy są całkowite.
  if old.allows_fraction and not new.allows_fraction then
    if exists (
      select 1 from public.stock_movements mv
      where mv.material_id = old.id and mv.quantity_delta <> trunc(mv.quantity_delta)
    ) then
      raise exception 'Nie można wyłączyć ułamków — materiał ma ruchy z ilością ułamkową'
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

-- ---------------------------------------------------------------------------
-- M2: niemutowalność — wyjątek sprzątania tylko dla is_test i tylko w sesji service_role
-- ---------------------------------------------------------------------------
create or replace function app.stock_history_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
     and current_setting('forbud.purge_test', true) = 'on'
     and current_setting('role', true) = 'service_role' then
    if tg_table_name = 'stock_movements' then
      if exists (select 1 from public.materials m where m.id = old.material_id and m.is_test) then
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

create or replace function app.stock_guard_write()
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
  if tg_op = 'DELETE'
     and current_setting('forbud.purge_test', true) = 'on'
     and current_setting('role', true) = 'service_role'
     and exists (select 1 from public.materials m where m.id = old.material_id and m.is_test) then
    return old;
  end if;
  raise exception 'Stan magazynowy zmieniają wyłącznie operacje magazynowe (z ruchem w historii)'
    using errcode = 'P0001', hint = 'IMMUTABLE';
end;
$$;

-- L4: INSERT do historii tylko z funkcji stockowych.
create function app.stock_history_guard_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_setting('forbud.stock_write', true) = 'on' then
    return new;
  end if;
  raise exception 'Operacje i ruchy magazynowe tworzą wyłącznie funkcje magazynowe'
    using errcode = 'P0001', hint = 'IMMUTABLE';
end;
$$;

revoke all on function app.stock_history_guard_insert() from public, anon, authenticated, service_role;

create trigger stock_operations_guard_insert
  before insert on public.stock_operations
  for each row execute function app.stock_history_guard_insert();
create trigger stock_movements_guard_insert
  before insert on public.stock_movements
  for each row execute function app.stock_history_guard_insert();

-- Sprzątanie: tylko materiały is_test = true. Wariant z prefiksem kodu usunięty (kod jest edytowalny).
drop function public.purge_test_stock(text);

create function public.purge_test_stock(p_material_ids uuid[] default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_ops uuid[];
  v_deleted integer;
begin
  if current_setting('role', true) is distinct from 'service_role' then
    raise exception 'Brak uprawnień' using errcode = '42501';
  end if;
  if p_material_ids is not null and exists (
    select 1 from unnest(p_material_ids) as x(id)
    where not exists (select 1 from public.materials m where m.id = x.id and m.is_test)
  ) then
    raise exception 'Można czyścić wyłącznie materiały testowe (is_test)' using errcode = '22023';
  end if;

  select coalesce(array_agg(m.id), '{}') into v_ids
  from public.materials m
  where m.is_test and (p_material_ids is null or m.id = any (p_material_ids));

  select coalesce(array_agg(distinct mv.operation_id), '{}') into v_ops
  from public.stock_movements mv
  where mv.material_id = any (v_ids);

  if exists (
    select 1 from public.stock_movements mv
    where mv.operation_id = any (v_ops) and not (mv.material_id = any (v_ids))
  ) then
    raise exception 'Operacja obejmuje materiał spoza danych testowych — przerwano' using errcode = 'P0001';
  end if;

  perform set_config('forbud.purge_test', 'on', true);
  delete from public.stock_movements mv where mv.material_id = any (v_ids);
  get diagnostics v_deleted = row_count;
  delete from public.stock_operations o where o.id = any (v_ops);
  delete from public.stock s where s.material_id = any (v_ids);
  perform set_config('forbud.purge_test', '', true);
  return v_deleted;
end;
$$;

revoke all on function public.purge_test_stock(uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.purge_test_stock(uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- M4: PRODUKCJA widzi tylko własne operacje i ruchy (ADMIN/BIURO — wszystkie)
-- ---------------------------------------------------------------------------
drop policy stock_operations_select on public.stock_operations;
drop policy stock_movements_select on public.stock_movements;
create policy stock_operations_select on public.stock_operations
  for select to authenticated
  using ((select app.user_role()) in ('ADMIN', 'BIURO') or ((select app.user_role()) is not null and user_id = (select auth.uid())));
create policy stock_movements_select on public.stock_movements
  for select to authenticated
  using ((select app.user_role()) in ('ADMIN', 'BIURO') or ((select app.user_role()) is not null and user_id = (select auth.uid())));

drop function public.list_stock_movements(text, text, date, date, integer, integer);

create function public.list_stock_movements(
  p_type text default null,
  p_material_q text default null,
  p_date_from date default null,
  p_date_to date default null,
  p_page integer default 1,
  p_page_size integer default 50,
  p_since timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role public.app_role := app.user_role();
  v_uid uuid := auth.uid();
  v_only uuid;
  v_pattern text;
  v_from timestamptz;
  v_to timestamptz;
  v_total bigint;
  v_items jsonb;
begin
  if v_role is null then
    raise exception 'Brak uprawnień' using errcode = '42501';
  end if;
  -- PRODUKCJA: wyłącznie własne ruchy (np. „Moje ostatnie przyjęcia” na terminalu).
  v_only := case when v_role = 'PRODUKCJA' then v_uid end;
  if p_page is null or p_page < 1 or p_page > 100000 or p_page_size is null or p_page_size < 1 or p_page_size > 100 then
    raise exception 'Nieprawidłowa strona' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  if p_type is not null and p_type not in ('RECEIPT', 'ISSUE', 'TRANSFER', 'ADJUSTMENT', 'INVENTORY') then
    raise exception 'Nieprawidłowy typ operacji' using errcode = 'P0001', hint = 'VALIDATION';
  end if;

  if nullif(btrim(p_material_q), '') is not null then
    v_pattern := '%' || replace(replace(replace(btrim(p_material_q), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;
  v_from := case when p_date_from is not null then p_date_from::timestamp at time zone 'Europe/Warsaw' end;
  v_to := case when p_date_to is not null then (p_date_to + 1)::timestamp at time zone 'Europe/Warsaw' end;
  if p_since is not null and (v_from is null or p_since > v_from) then
    v_from := p_since;
  end if;

  select count(*) into v_total
  from public.stock_movements mv
  join public.stock_operations o on o.id = mv.operation_id
  join public.materials m on m.id = mv.material_id
  where (p_type is null or o.type = p_type)
    and (v_only is null or mv.user_id = v_only)
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
      and (v_only is null or mv.user_id = v_only)
      and (v_pattern is null or m.code ilike v_pattern or m.name ilike v_pattern)
      and (v_from is null or mv.created_at >= v_from)
      and (v_to is null or mv.created_at < v_to)
    order by mv.created_at desc, mv.id desc
    limit p_page_size offset (p_page - 1) * p_page_size
  ) q;

  return jsonb_build_object('total', v_total, 'items', v_items);
end;
$$;

revoke all on function public.list_stock_movements(text, text, date, date, integer, integer, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.list_stock_movements(text, text, date, date, integer, integer, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- L4 + L5: stock_receipt — flaga zapisu przed INSERT do historii, materiał FOR NO KEY UPDATE
-- ---------------------------------------------------------------------------
create or replace function public.stock_receipt(
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

  -- 2. Idempotencja (advisory lock na id; unique(client_request_id) jako ostatnia bariera).
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

  -- 3. Blokady. Materiał FOR NO KEY UPDATE: serializuje operacje na materiale i koliduje z UPDATE
  -- kartoteki, ale nie blokuje sprawdzeń kluczy obcych (FOR KEY SHARE). Kolejność blokad: materiał(y)
  -- → lokalizacja(e) → dostawca; przy wielu materiałach/lokalizacjach — rosnąco po id (ADR 009).
  select m.id, m.active, m.allows_fraction into v_material
  from public.materials m
  where m.id = p_material_id
  for no key update;
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

  -- 4. Walidacja
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

  -- 5. Zapis (flaga zapisu obejmuje historię i stan; zerowana zaraz potem)
  perform set_config('forbud.stock_write', 'on', true);

  insert into public.stock_operations (type, user_id, client_request_id, supplier_id, document_ref, note)
  values ('RECEIPT', v_uid, p_client_request_id, p_supplier_id, v_doc, v_note)
  returning * into v_op;

  insert into public.stock_movements (operation_id, material_id, location_id, quantity_delta, user_id, created_at)
  values (v_op.id, p_material_id, p_location_id, p_quantity, v_uid, v_op.created_at)
  returning * into v_mv;

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
