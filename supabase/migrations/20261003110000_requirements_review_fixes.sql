-- Poprawki po review Etapu 8–10 (ADR 013):
--  M1  create_requirement: replay porównuje nazwę i znormalizowany zbiór pozycji (request_hash), różnica → IDEMPOTENCY_CONFLICT;
--  L1  wydajność braków: agregacje per (zlecenie, materiał) w CTE MATERIALIZED przed joinami (hash-join-friendly),
--      każda funkcja liczy bilans RAZ (wcześniej order_shortages/order_to_issue wołały go dwukrotnie);
--  L2  „brakuje” / has_shortage tylko dla zleceń OPEN / IN_PRODUCTION (zamknięte → 0 / false);
--  L4  order_overview / requirement_balance: array_remove(p_order_ids, null).
-- Migracja addytywna: nowa kolumna + create or replace funkcji o niezmienionych sygnaturach.

alter table public.requirements add column request_hash text;
comment on column public.requirements.request_hash is
  'md5 nazwy i znormalizowanych pozycji listy (material_id|ilość|notatka) — porównanie przy powtórzeniu żądania (idempotencja).';

-- ---------------------------------------------------------------------------
-- L1/L4: bilans per (zlecenie, materiał)
-- ---------------------------------------------------------------------------
create or replace function app.requirement_balance(p_order_ids uuid[] default null)
returns table (production_order_id uuid, material_id uuid, needed numeric, issued numeric, remaining numeric)
language sql
stable
security definer
set search_path = ''
as $$
  with ord as materialized (
    select po.id
    from public.production_orders po
    where case
            when p_order_ids is null then po.status in ('OPEN', 'IN_PRODUCTION')
            else po.id = any (array_remove(p_order_ids, null))
          end
  ), need as materialized (
    select r.production_order_id, i.material_id, sum(i.quantity) as needed
    from public.requirements r
    join ord on ord.id = r.production_order_id
    join public.requirement_items i on i.requirement_id = r.id
    where r.status = 'ACTIVE'
    group by r.production_order_id, i.material_id
  ), need_orders as materialized (
    select distinct n.production_order_id from need n
  ), iss as materialized (
    select o.production_order_id, mv.material_id, -sum(mv.quantity_delta) as issued
    from public.stock_operations o
    join need_orders no on no.production_order_id = o.production_order_id
    join public.stock_movements mv on mv.operation_id = o.id
    where o.type in ('ISSUE', 'REVERSAL')
    group by o.production_order_id, mv.material_id
  )
  select n.production_order_id, n.material_id, n.needed,
         coalesce(s.issued, 0),
         greatest(n.needed - coalesce(s.issued, 0), 0)
  from need n
  left join iss s on s.production_order_id = n.production_order_id and s.material_id = n.material_id
$$;
revoke all on function app.requirement_balance(uuid[]) from public, anon, authenticated, service_role;

create or replace function app.shortage_available(p_material_ids uuid[])
returns table (material_id uuid, available numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select s.material_id, sum(s.quantity)
  from public.stock s
  join public.locations l on l.id = s.location_id and l.active
  where s.material_id = any (p_material_ids)
  group by s.material_id
$$;
revoke all on function app.shortage_available(uuid[]) from public, anon, authenticated, service_role;

create or replace function app.shortage_rows(p_supplier_id uuid, p_category_id uuid, p_only_short boolean)
returns table (
  material_id uuid, material_code text, material_name text, unit text,
  category_id uuid, category_name text, supplier_id uuid, supplier_name text,
  remaining numeric, available numeric, shortage numeric, orders jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  with bal as materialized (
    select b.production_order_id, b.material_id, b.remaining
    from app.requirement_balance(null) b
    where b.remaining > 0
  ), per_mat as materialized (
    select b.material_id,
           sum(b.remaining) as remaining,
           jsonb_agg(
             jsonb_build_object('order_id', b.production_order_id, 'number', po.number, 'name', po.name, 'remaining', b.remaining)
             order by po.created_at, po.id) as orders
    from bal b
    join public.production_orders po on po.id = b.production_order_id
    group by b.material_id
  ), avail as materialized (
    select a.material_id, a.available
    from app.shortage_available((select coalesce(array_agg(p.material_id), '{}') from per_mat p)) a
  )
  select m.id, m.code, m.name, m.unit, c.id, c.name, su.id, su.name,
         pm.remaining, coalesce(a.available, 0), greatest(pm.remaining - coalesce(a.available, 0), 0), pm.orders
  from per_mat pm
  join public.materials m on m.id = pm.material_id
  join public.material_categories c on c.id = m.category_id
  left join public.suppliers su on su.id = m.default_supplier_id
  left join avail a on a.material_id = pm.material_id
  where (p_supplier_id is null or m.default_supplier_id = p_supplier_id)
    and (p_category_id is null or m.category_id = p_category_id)
    and (not coalesce(p_only_short, false) or pm.remaining > coalesce(a.available, 0))
$$;
revoke all on function app.shortage_rows(uuid, uuid, boolean) from public, anon, authenticated, service_role;

-- order_shortages: bilans raz; „brakuje” tylko dla zleceń OPEN / IN_PRODUCTION (L2).
create or replace function public.order_shortages(p_order_id uuid)
returns table (
  material_id uuid, material_code text, material_name text, unit text,
  needed numeric, issued numeric, remaining numeric, available numeric, shortage numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select app.user_role()) is distinct from 'ADMIN' and (select app.user_role()) is distinct from 'BIURO' then
    raise exception 'Brak uprawnień' using errcode = '42501';
  end if;
  return query
    with bal as materialized (
      select * from app.requirement_balance(array[p_order_id])
    ), avail as materialized (
      select a.material_id, a.available
      from app.shortage_available((select coalesce(array_agg(x.material_id), '{}') from bal x)) a
    ), st as (
      select po.status in ('OPEN', 'IN_PRODUCTION') as issuable from public.production_orders po where po.id = p_order_id
    )
    select b.material_id, m.code, m.name, m.unit, b.needed, b.issued, b.remaining,
           coalesce(av.available, 0),
           case when coalesce((select s.issuable from st s), false)
                then greatest(b.remaining - coalesce(av.available, 0), 0) else 0 end
    from bal b
    join public.materials m on m.id = b.material_id
    left join avail av on av.material_id = b.material_id
    order by 9 desc, m.code;
end;
$$;
revoke all on function public.order_shortages(uuid) from public, anon, authenticated, service_role;
grant execute on function public.order_shortages(uuid) to authenticated;

-- order_overview: flaga braków tylko dla zleceń do wydania (L2); array_remove (L4).
create or replace function public.order_overview(p_order_ids uuid[])
returns table (production_order_id uuid, requirement_count integer, has_shortage boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ids uuid[] := array_remove(p_order_ids, null);
begin
  if (select app.user_role()) is distinct from 'ADMIN' and (select app.user_role()) is distinct from 'BIURO' then
    raise exception 'Brak uprawnień' using errcode = '42501';
  end if;
  if p_order_ids is null or cardinality(v_ids) > 200 then
    raise exception 'Zbyt wiele zleceń' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  return query
    with bal as materialized (
      select * from app.requirement_balance(v_ids)
    ), avail as materialized (
      select a.material_id, a.available
      from app.shortage_available((select coalesce(array_agg(distinct x.material_id), '{}') from bal x)) a
    ), cnt as (
      select r.production_order_id as oid, count(*)::integer as n
      from public.requirements r
      where r.production_order_id = any (v_ids) and r.status = 'ACTIVE'
      group by r.production_order_id
    )
    select po.id,
           coalesce(c.n, 0),
           po.status in ('OPEN', 'IN_PRODUCTION') and coalesce(bool_or(b.remaining > coalesce(av.available, 0)), false)
    from public.production_orders po
    left join cnt c on c.oid = po.id
    left join bal b on b.production_order_id = po.id
    left join avail av on av.material_id = b.material_id
    where po.id = any (v_ids)
    group by po.id, po.status, c.n;
end;
$$;
revoke all on function public.order_overview(uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.order_overview(uuid[]) to authenticated;

create or replace function public.order_to_issue(p_order_id uuid)
returns table (
  material_id uuid, material_code text, material_name text, unit text, allows_fraction boolean,
  remaining numeric, available numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select app.user_role()) is null then
    raise exception 'Brak uprawnień' using errcode = '42501';
  end if;
  return query
    with bal as materialized (
      select * from app.requirement_balance(array[p_order_id]) b where b.remaining > 0
    ), avail as materialized (
      select a.material_id, a.available
      from app.shortage_available((select coalesce(array_agg(x.material_id), '{}') from bal x)) a
    )
    select b.material_id, m.code, m.name, m.unit, m.allows_fraction, b.remaining, coalesce(av.available, 0)
    from bal b
    join public.materials m on m.id = b.material_id
    left join avail av on av.material_id = b.material_id
    order by m.code;
end;
$$;
revoke all on function public.order_to_issue(uuid) from public, anon, authenticated, service_role;
grant execute on function public.order_to_issue(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- M1: create_requirement z request_hash
-- ---------------------------------------------------------------------------
create or replace function public.create_requirement(
  p_order_id uuid,
  p_name text,
  p_items jsonb,
  p_client_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role public.app_role := app.user_role();
  v_name text := btrim(p_name);
  v_status text;
  v_req public.requirements%rowtype;
  v_count integer;
  v_distinct integer;
  v_bad text;
  v_hash text;
begin
  if v_uid is null or v_role is null or v_role not in ('ADMIN', 'BIURO') then
    raise exception 'Brak uprawnień do tworzenia zapotrzebowania' using errcode = '42501';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 500 then
    raise exception 'Lista musi mieć od 1 do 500 pozycji' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  if exists (select 1 from jsonb_array_elements(p_items) e where jsonb_typeof(e) <> 'object') then
    raise exception 'Nieprawidłowa pozycja listy' using errcode = 'P0001', hint = 'VALIDATION';
  end if;

  -- Odcisk żądania: nazwa + zlecenie + pozycje (materiał|ilość bez zer końcowych|notatka po trim), posortowane po materiale.
  -- Rzutowania (uuid / numeric) przy złym formacie dają 22P02 (API: 400 VALIDATION).
  select md5(coalesce(v_name, '') || E'\n' || p_order_id::text || E'\n' ||
             coalesce(string_agg(
               coalesce(x.material_id::text, '') || '|' || coalesce(trim_scale(x.quantity)::text, '') || '|' ||
               coalesce(nullif(btrim(x.note), ''), ''),
               E'\n' order by x.material_id, x.quantity), ''))
  into v_hash
  from jsonb_to_recordset(p_items) as x(material_id uuid, quantity numeric, note text);

  if p_client_request_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('forbud.requirement:' || p_client_request_id::text, 0));
    select * into v_req from public.requirements r where r.client_request_id = p_client_request_id;
    if found then
      if v_req.created_by is distinct from v_uid or v_req.request_hash is distinct from v_hash then
        raise exception 'Ten identyfikator żądania został już użyty dla innej listy' using errcode = 'P0001', hint = 'IDEMPOTENCY_CONFLICT';
      end if;
      return jsonb_build_object(
        'requirement_id', v_req.id,
        'item_count', (select count(*) from public.requirement_items i where i.requirement_id = v_req.id),
        'idempotent_replay', true
      );
    end if;
  end if;

  if v_name is null or length(v_name) not between 1 and 120 then
    raise exception 'Nazwa listy: 1–120 znaków' using errcode = 'P0001', hint = 'VALIDATION';
  end if;

  select count(*), count(distinct x.material_id) into v_count, v_distinct
  from jsonb_to_recordset(p_items) as x(material_id uuid, quantity numeric, note text);
  if exists (select 1 from jsonb_to_recordset(p_items) as x(material_id uuid, quantity numeric, note text) where x.material_id is null) then
    raise exception 'Pozycja bez materiału' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  if v_distinct < v_count then
    raise exception 'Ten sam materiał występuje na liście więcej niż raz' using errcode = 'P0001', hint = 'DUPLICATE_MATERIAL';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_items) as x(material_id uuid, quantity numeric, note text)
    where x.quantity is null or x.quantity <= 0 or x.quantity > 1000000 or x.quantity <> round(x.quantity, 3)
  ) then
    raise exception 'Ilość musi być większa od zera, maksymalnie 1 000 000, do 3 miejsc po przecinku'
      using errcode = 'P0001', hint = 'INVALID_QUANTITY';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_items) as x(material_id uuid, quantity numeric, note text)
    where length(btrim(x.note)) > 200
  ) then
    raise exception 'Notatka pozycji: do 200 znaków' using errcode = 'P0001', hint = 'VALIDATION';
  end if;

  select po.status into v_status from public.production_orders po where po.id = p_order_id for share;
  if not found then
    raise exception 'Nie znaleziono zlecenia' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'order';
  end if;
  if v_status not in ('OPEN', 'IN_PRODUCTION') then
    raise exception 'Zlecenie jest zakończone lub anulowane — otwórz je ponownie, aby dodać listę'
      using errcode = 'P0001', hint = 'ORDER_NOT_OPEN';
  end if;

  if exists (
    select 1 from jsonb_to_recordset(p_items) as x(material_id uuid, quantity numeric, note text)
    where not exists (select 1 from public.materials m where m.id = x.material_id)
  ) then
    raise exception 'Nie znaleziono materiału' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'material';
  end if;
  select m.code into v_bad
  from jsonb_to_recordset(p_items) as x(material_id uuid, quantity numeric, note text)
  join public.materials m on m.id = x.material_id
  where not m.active
  order by m.code limit 1;
  if v_bad is not null then
    raise exception 'Materiał jest nieaktywny' using errcode = 'P0001', hint = 'MATERIAL_INACTIVE', detail = v_bad;
  end if;
  select m.code into v_bad
  from jsonb_to_recordset(p_items) as x(material_id uuid, quantity numeric, note text)
  join public.materials m on m.id = x.material_id
  where not m.allows_fraction and x.quantity <> trunc(x.quantity)
  order by m.code limit 1;
  if v_bad is not null then
    raise exception 'Ten materiał liczy się w całych jednostkach' using errcode = 'P0001', hint = 'NOT_INTEGER', detail = v_bad;
  end if;

  insert into public.requirements (production_order_id, source, name, client_request_id, request_hash)
  values (p_order_id, 'MANUAL', v_name, p_client_request_id, v_hash)
  returning * into v_req;

  insert into public.requirement_items (requirement_id, material_id, quantity, note)
  select v_req.id, x.material_id, x.quantity, nullif(btrim(x.note), '')
  from jsonb_to_recordset(p_items) as x(material_id uuid, quantity numeric, note text);

  return jsonb_build_object('requirement_id', v_req.id, 'item_count', v_count, 'idempotent_replay', false);
end;
$$;
revoke all on function public.create_requirement(uuid, text, jsonb, uuid) from public, anon, authenticated, service_role;
grant execute on function public.create_requirement(uuid, text, jsonb, uuid) to authenticated;
