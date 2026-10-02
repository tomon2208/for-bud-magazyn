-- Poprawki po review Etapu 11 (ADR 014, sekcja „Poprawki po review”):
--  M1a  „poniżej minimum” liczone od WOLNEGO (stan w aktywnych lokalizacjach − rezerwacje) — v_stock, v_material_stock
--       (below_minimum, shortage, in_view), dashboard (przez v_material_stock), eksport CSV stanów (+ kolumny
--       zarezerwowane / wolne). Decyzja użytkownika zgodna z ADR 012.
--  M1b  rezerwacje ponad zapotrzebowanie (np. po wycofaniu listy): release_reservation_excess (jedna transakcja,
--       powód „Nadmiar po wycofaniu listy”), reservations_over_requirement() + licznik w dashboard_stats.
--  L1   RLS reservation_events: SELECT tylko ADMIN / BIURO (terminal korzysta z material_availability).
--  L2   purge_test_stock: żądania i rezerwacje wyłącznie zleceń o nazwie TEST-… (inne id są pomijane).
-- stock_issue bez zmian (L7 — opis w ADR).

-- ---------------------------------------------------------------------------
-- M1a: widoki (poprzednie definicje: 20261004100000)
-- ---------------------------------------------------------------------------
-- v_stock: below_minimum = wolne materiału < minimum; nowa kolumna material_free na końcu.
create or replace view public.v_stock
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
  s.updated_at,
  m.category_id,
  m.min_quantity,
  (
    m.active
    and m.min_quantity is not null
    and greatest(
          (select coalesce(sum(s2.quantity), 0) from public.stock s2 join public.locations l2 on l2.id = s2.location_id and l2.active
           where s2.material_id = s.material_id)
          - (select coalesce(sum(r.quantity), 0) from public.reservations r where r.material_id = s.material_id and r.quantity > 0),
          0) < m.min_quantity
  ) as below_minimum,
  -- Rezerwacje są globalne per materiał — te same wartości w każdym wierszu lokalizacji materiału.
  (select coalesce(sum(r.quantity), 0) from public.reservations r where r.material_id = s.material_id and r.quantity > 0)
    as material_reserved,
  greatest(
    (select coalesce(sum(s2.quantity), 0) from public.stock s2 join public.locations l2 on l2.id = s2.location_id and l2.active
     where s2.material_id = s.material_id)
    - (select coalesce(sum(r.quantity), 0) from public.reservations r where r.material_id = s.material_id and r.quantity > 0),
    0) as material_free
from public.stock s
join public.materials m on m.id = s.material_id
join public.locations l on l.id = s.location_id;

-- v_material_stock: below_minimum / shortage / in_view liczone od wolnego (free_quantity).
create or replace view public.v_material_stock
with (security_invoker = true)
as
select
  m.id as material_id,
  m.code as material_code,
  m.name as material_name,
  m.unit,
  m.allows_fraction,
  m.active as material_active,
  m.category_id,
  c.name as category_name,
  m.default_supplier_id,
  sp.name as default_supplier_name,
  m.min_quantity,
  coalesce(t.total, 0) as total_quantity,
  coalesce(t.locations, 0)::integer as location_count,
  (m.active and m.min_quantity is not null
    and greatest(coalesce(t.total_active, 0) - coalesce(rs.reserved, 0), 0) < m.min_quantity) as below_minimum,
  case
    when m.active and m.min_quantity is not null
      then greatest(m.min_quantity - greatest(coalesce(t.total_active, 0) - coalesce(rs.reserved, 0), 0), 0)
    else 0
  end as shortage,
  (coalesce(t.total, 0) > 0
    or (m.active and m.min_quantity is not null
        and greatest(coalesce(t.total_active, 0) - coalesce(rs.reserved, 0), 0) < m.min_quantity)) as in_view,
  coalesce(rs.reserved, 0) as reserved_quantity,
  greatest(coalesce(t.total_active, 0) - coalesce(rs.reserved, 0), 0) as free_quantity,
  coalesce(rs.reserved, 0) > coalesce(t.total_active, 0) as over_reserved
from public.materials m
join public.material_categories c on c.id = m.category_id
left join public.suppliers sp on sp.id = m.default_supplier_id
left join lateral (
  select sum(s.quantity) as total,
         count(*) filter (where s.quantity > 0) as locations,
         sum(s.quantity) filter (where l.active) as total_active
  from public.stock s
  join public.locations l on l.id = s.location_id
  where s.material_id = m.id
) t on true
left join lateral (
  select sum(r.quantity) as reserved
  from public.reservations r
  where r.material_id = m.id and r.quantity > 0
) rs on true;

grant select on table public.v_material_stock to authenticated, service_role;
grant select on table public.v_stock to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- M1a: eksport CSV stanów (poprzednia definicja: 20261002150000) — + zarezerwowane / wolne
-- ---------------------------------------------------------------------------
create or replace function public.export_stock_csv(
  p_variant text,
  p_q text default null,
  p_category_id uuid default null,
  p_below_min boolean default false
)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  c_limit constant integer := 20000;
  v_pattern text;
  v_count integer;
  v_body text;
  v_header text;
begin
  if (select app.user_role()) is distinct from 'ADMIN' and (select app.user_role()) is distinct from 'BIURO' then
    raise exception 'Brak uprawnień' using errcode = '42501';
  end if;
  if p_variant not in ('location', 'material') then
    raise exception 'Nieprawidłowy wariant eksportu' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  if nullif(btrim(p_q), '') is not null then
    v_pattern := '%' || replace(replace(replace(btrim(p_q), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  if p_variant = 'location' then
    v_header := 'Kod materiału;Nazwa materiału;Kategoria;Jednostka;Lokalizacja;Nazwa lokalizacji;Ilość;'
                || 'Zarezerwowane (materiał);Wolne (materiał)';
    select count(*),
           string_agg(
             app.csv_code(r.material_code) || ';' || app.csv_text(r.material_name) || ';' ||
             app.csv_text(r.category_name) || ';' || app.csv_text(r.unit) || ';' ||
             app.csv_code(r.location_code) || ';' || app.csv_text(r.location_name) || ';' ||
             app.csv_num(r.quantity) || ';' || app.csv_num(r.material_reserved) || ';' || app.csv_num(r.material_free),
             E'\r\n' order by r.material_code, r.location_code)
    into v_count, v_body
    from (
      select v.material_code, v.material_name, c.name as category_name, v.unit,
             v.location_code, v.location_name, v.quantity, v.material_reserved, v.material_free
      from public.v_stock v
      join public.material_categories c on c.id = v.category_id
      where v.quantity > 0
        and (p_category_id is null or v.category_id = p_category_id)
        and (not coalesce(p_below_min, false) or v.below_minimum)
        and (v_pattern is null
             or v.material_code ilike v_pattern
             or v.material_name ilike v_pattern
             or v.location_code ilike v_pattern)
      order by v.material_code, v.location_code
      limit c_limit + 1
    ) r;
  else
    v_header := 'Kod materiału;Nazwa materiału;Kategoria;Jednostka;Stan łączny;Zarezerwowane;Wolne;Stan minimalny;'
                || 'Brakuje do minimum;Poniżej minimum;Liczba lokalizacji;Domyślny dostawca';
    select count(*),
           string_agg(
             app.csv_code(r.material_code) || ';' || app.csv_text(r.material_name) || ';' ||
             app.csv_text(r.category_name) || ';' || app.csv_text(r.unit) || ';' ||
             app.csv_num(r.total_quantity) || ';' || app.csv_num(r.reserved_quantity) || ';' ||
             app.csv_num(r.free_quantity) || ';' || app.csv_num(r.min_quantity) || ';' ||
             app.csv_num(r.shortage) || ';' || case when r.below_minimum then 'TAK' else 'NIE' end || ';' ||
             r.location_count::text || ';' || app.csv_text(r.default_supplier_name),
             E'\r\n' order by r.material_code)
    into v_count, v_body
    from (
      select v.material_code, v.material_name, v.category_name, v.unit,
             v.total_quantity, v.reserved_quantity, v.free_quantity, v.min_quantity, v.shortage, v.below_minimum,
             v.location_count, v.default_supplier_name
      from public.v_material_stock v
      where v.in_view
        and (p_category_id is null or v.category_id = p_category_id)
        and (not coalesce(p_below_min, false) or v.below_minimum)
        and (v_pattern is null or v.material_code ilike v_pattern or v.material_name ilike v_pattern)
      order by v.material_code
      limit c_limit + 1
    ) r;
  end if;

  if v_count > c_limit then
    raise exception 'Zbyt wiele wierszy do eksportu (maks. %) — zawęź filtry', c_limit
      using errcode = 'P0001', hint = 'TOO_MANY_ROWS';
  end if;
  return v_header || E'\r\n' || case when v_body is null then '' else v_body || E'\r\n' end;
end;
$$;

-- ---------------------------------------------------------------------------
-- M1b: rezerwacje ponad zapotrzebowanie
-- ---------------------------------------------------------------------------
-- Wiersze (zlecenie OPEN/IN_PRODUCTION, materiał) z rezerwacją > pozostało do wydania. ADMIN, BIURO.
-- p_order_id NULL = wszystkie zlecenia.
create function public.reservations_over_requirement(p_order_id uuid default null)
returns table (
  production_order_id uuid, order_number text, order_name text, material_id uuid, material_code text, unit text,
  reserved numeric, remaining numeric, excess numeric
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
    with res as materialized (
      select r.production_order_id, r.material_id, r.quantity
      from public.reservations r
      join public.production_orders po on po.id = r.production_order_id and po.status in ('OPEN', 'IN_PRODUCTION')
      where r.quantity > 0 and (p_order_id is null or r.production_order_id = p_order_id)
    ), bal as materialized (
      select b.production_order_id, b.material_id, b.remaining
      from app.requirement_balance((select coalesce(array_agg(distinct x.production_order_id), '{}') from res x)) b
    )
    select x.production_order_id, po.number, po.name, x.material_id, m.code, m.unit,
           x.quantity, coalesce(b.remaining, 0), x.quantity - coalesce(b.remaining, 0)
    from res x
    join public.production_orders po on po.id = x.production_order_id
    join public.materials m on m.id = x.material_id
    left join bal b on b.production_order_id = x.production_order_id and b.material_id = x.material_id
    where x.quantity > coalesce(b.remaining, 0)
    order by po.created_at, po.id, m.code
    limit 500;
end;
$$;
revoke all on function public.reservations_over_requirement(uuid) from public, anon, authenticated, service_role;
grant execute on function public.reservations_over_requirement(uuid) to authenticated;

-- Zwolnienie nadmiaru (rezerwacja − pozostało do wydania) dla wszystkich materiałów zlecenia — jedna transakcja,
-- zdarzenia RELEASE z powodem. Blokady jak release_reservation: materiały rosnąco → wiersze rezerwacji zlecenia;
-- bilans liczony po blokadach. BIURO, ADMIN. Idempotencja jak w release_reservation (rodzaj RELEASE, inny odcisk).
create function public.release_reservation_excess(
  p_client_request_id uuid,
  p_order_id uuid,
  p_reason text default 'Nadmiar po wycofaniu listy'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role public.app_role := app.user_role();
  v_reason text := coalesce(nullif(btrim(p_reason), ''), 'Nadmiar po wycofaniu listy');
  v_hash text;
  v_req public.reservation_requests%rowtype;
  v_mats uuid[];
  v_row record;
  v_after numeric;
  v_released jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  if v_uid is null or v_role is null or v_role not in ('ADMIN', 'BIURO') then
    raise exception 'Brak uprawnień do zwalniania rezerwacji' using errcode = '42501';
  end if;
  if p_client_request_id is null or p_order_id is null then
    raise exception 'Brak identyfikatora żądania lub zlecenia' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  if length(v_reason) > 200 then
    raise exception 'Powód do 200 znaków' using errcode = 'P0001', hint = 'VALIDATION';
  end if;

  v_hash := md5('RELEASE_EXCESS|' || p_order_id::text || '|' || v_reason);
  perform pg_advisory_xact_lock(hashtextextended('forbud.reservation:' || p_client_request_id::text, 0));
  select * into v_req from public.reservation_requests q where q.id = p_client_request_id;
  if found then
    if v_req.user_id <> v_uid or v_req.kind <> 'RELEASE' or v_req.request_hash <> v_hash then
      raise exception 'Ten identyfikator żądania został już użyty dla innej operacji'
        using errcode = 'P0001', hint = 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_req.result || jsonb_build_object('idempotent_replay', true);
  end if;

  if not exists (select 1 from public.production_orders po where po.id = p_order_id) then
    raise exception 'Nie znaleziono zlecenia' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'order';
  end if;

  select coalesce(array_agg(r.material_id order by r.material_id), '{}') into v_mats
  from public.reservations r
  where r.production_order_id = p_order_id and r.quantity > 0;

  perform 1 from public.materials m where m.id = any (v_mats) order by m.id for no key update;
  perform 1 from public.reservations r
  where r.production_order_id = p_order_id and r.material_id = any (v_mats)
  order by r.material_id
  for update;

  perform set_config('forbud.reservation_write', 'on', true);
  for v_row in
    with bal as materialized (
      select b.material_id, b.remaining from app.requirement_balance(array[p_order_id]) b
    )
    select r.id, r.material_id, r.quantity, m.code, r.quantity - coalesce(b.remaining, 0) as excess
    from public.reservations r
    join public.materials m on m.id = r.material_id
    left join bal b on b.material_id = r.material_id
    where r.production_order_id = p_order_id and r.material_id = any (v_mats)
      and r.quantity > coalesce(b.remaining, 0)
    order by r.material_id
  loop
    update public.reservations r
    set quantity = r.quantity - v_row.excess, updated_at = now()
    where r.id = v_row.id
    returning r.quantity into v_after;
    insert into public.reservation_events (reservation_id, type, quantity_delta, quantity_after, request_id, reason, user_id)
    values (v_row.id, 'RELEASE', -v_row.excess, v_after, p_client_request_id, v_reason, v_uid);
    v_released := v_released || jsonb_build_object(
      'material_id', v_row.material_id, 'material_code', v_row.code, 'quantity', v_row.excess, 'reserved_after', v_after);
  end loop;

  if jsonb_array_length(v_released) = 0 then
    raise exception 'Brak rezerwacji ponad zapotrzebowanie' using errcode = 'P0001', hint = 'NOTHING_TO_RELEASE';
  end if;

  v_result := jsonb_build_object('order_id', p_order_id, 'released', v_released);
  insert into public.reservation_requests (id, kind, production_order_id, user_id, request_hash, result)
  values (p_client_request_id, 'RELEASE', p_order_id, v_uid, v_hash, v_result);
  perform set_config('forbud.reservation_write', '', true);
  return v_result || jsonb_build_object('idempotent_replay', false);
end;
$$;
revoke all on function public.release_reservation_excess(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.release_reservation_excess(uuid, uuid, text) to authenticated;

-- dashboard_stats (poprzednia definicja: 20261004100000) + over_requirement_orders. below_minimum — z v_material_stock
-- (teraz od wolnego).
create or replace function public.dashboard_stats()
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_day_start timestamptz := date_trunc('day', now() at time zone 'Europe/Warsaw') at time zone 'Europe/Warsaw';
begin
  if (select app.user_role()) is distinct from 'ADMIN' and (select app.user_role()) is distinct from 'BIURO' then
    raise exception 'Brak uprawnień' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'active_materials', (select count(*) from public.materials where active),
    'active_locations', (select count(*) from public.locations where active),
    'materials_in_stock', (select count(distinct material_id) from public.stock where quantity > 0),
    'below_minimum', (select count(*) from public.v_material_stock where below_minimum),
    'operations_today', coalesce(
      (select jsonb_object_agg(t.type, t.n)
       from (
         select o.type, count(*) as n
         from public.stock_operations o
         where o.created_at >= v_day_start
         group by o.type
       ) t),
      '{}'::jsonb),
    'reserved_materials', (select count(distinct r.material_id) from public.reservations r where r.quantity > 0),
    'over_reserved', (
      select count(*)
      from (
        select r.material_id, sum(r.quantity) as reserved
        from public.reservations r
        where r.quantity > 0
        group by r.material_id
      ) x
      where x.reserved > coalesce((
        select sum(s.quantity) from public.stock s join public.locations l on l.id = s.location_id and l.active
        where s.material_id = x.material_id), 0)
    ),
    'over_requirement_orders', (select count(distinct x.production_order_id) from public.reservations_over_requirement(null) x)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- L1: historia rezerwacji — tylko ADMIN / BIURO
-- ---------------------------------------------------------------------------
drop policy reservation_events_select on public.reservation_events;
create policy reservation_events_select on public.reservation_events
  for select to authenticated using ((select app.user_role()) in ('ADMIN', 'BIURO'));

-- ---------------------------------------------------------------------------
-- L2: purge_test_stock — żądania/rezerwacje wyłącznie zleceń TEST-… (poprzednia definicja: 20261004100000)
-- ---------------------------------------------------------------------------
create or replace function public.purge_test_stock(p_material_ids uuid[] default null, p_order_ids uuid[] default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_ops uuid[];
  v_orders uuid[];
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

  -- Zlecenia: tylko o nazwie TEST-… (pozostałe wskazane id są pomijane — prawdziwe zlecenia nie są ruszane).
  select coalesce(array_agg(po.id), '{}') into v_orders
  from public.production_orders po
  where po.id = any (coalesce(p_order_ids, '{}')) and po.name like 'TEST-%';

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
  delete from public.reservation_events e
  using public.reservations r
  where r.id = e.reservation_id and r.material_id = any (v_ids);
  delete from public.reservations r where r.material_id = any (v_ids);
  if cardinality(v_orders) > 0 then
    if exists (select 1 from public.reservations r where r.production_order_id = any (v_orders)) then
      raise exception 'Zlecenie ma rezerwacje materiałów spoza danych testowych — przerwano' using errcode = 'P0001';
    end if;
    delete from public.reservation_requests q where q.production_order_id = any (v_orders);
  end if;

  delete from public.stock_movements mv where mv.material_id = any (v_ids);
  get diagnostics v_deleted = row_count;
  delete from public.stock_operations o where o.id = any (v_ops);
  delete from public.stock s where s.material_id = any (v_ids);
  perform set_config('forbud.purge_test', '', true);
  return v_deleted;
end;
$$;
revoke all on function public.purge_test_stock(uuid[], uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.purge_test_stock(uuid[], uuid[]) to service_role;
