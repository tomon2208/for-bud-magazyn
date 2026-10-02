-- Etap 7: stan minimalny materiału, widoki sum per materiał, statystyki dashboardu, eksport stanów (ADR 012).
-- Migracja addytywna: nowa kolumna materials.min_quantity (NULL = brak alarmu), trigger walidacji,
-- rozszerzenie v_stock o kolumny na końcu, nowy widok v_material_stock, dwie funkcje odczytu, indeks.
-- Żadna funkcja zmieniająca stan (stock_receipt/issue/transfer/adjust/reverse) nie jest ruszana.

-- ---------------------------------------------------------------------------
-- 1. materials.min_quantity
-- ---------------------------------------------------------------------------
alter table public.materials
  add column min_quantity numeric(12, 3)
    constraint materials_min_quantity_valid check (min_quantity is null or (min_quantity >= 0 and min_quantity <= 1000000));

comment on column public.materials.min_quantity is
  'Stan minimalny (opcjonalny; NULL = brak alarmu). Materiał jest „poniżej minimum”, gdy suma stanu we wszystkich lokalizacjach < min_quantity (tylko aktywne). Skala zgodna z allows_fraction.';

-- Walidacja całkowitości: trigger „zz” odpala się po materials_normalize (kontrola roli → 42501) i po
-- materials_z_stock_guard (który ustala allows_fraction przy INSERT bez wartości).
create function app.materials_min_quantity_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.min_quantity is not null
     and not new.allows_fraction
     and new.min_quantity <> trunc(new.min_quantity) then
    raise exception 'Stan minimalny tego materiału musi być liczbą całkowitą (materiał bez ułamków)'
      using errcode = 'P0001', hint = 'MIN_NOT_INTEGER';
  end if;
  return new;
end;
$$;

revoke all on function app.materials_min_quantity_guard() from public, anon, authenticated;

create trigger materials_zz_min_quantity
  before insert or update on public.materials
  for each row execute function app.materials_min_quantity_guard();

-- ---------------------------------------------------------------------------
-- 2. v_stock: dodatkowe kolumny NA KOŃCU (kategoria, minimum, flaga „poniżej minimum”)
-- ---------------------------------------------------------------------------
-- below_minimum to skorelowane podzapytanie — planista pomija je, gdy kolumna nie jest wybierana.
-- Etap 11 (rezerwacje): „dostępne” = suma stanu − aktywne rezerwacje; flaga ma porównywać stan DOSTĘPNY.
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
    and (select coalesce(sum(s2.quantity), 0) from public.stock s2 where s2.material_id = s.material_id) < m.min_quantity
  ) as below_minimum
from public.stock s
join public.materials m on m.id = s.material_id
join public.locations l on l.id = s.location_id;

-- ---------------------------------------------------------------------------
-- 3. v_material_stock: suma per materiał (także materiały bez stanu)
-- ---------------------------------------------------------------------------
-- total_quantity = suma po wszystkich lokalizacjach (łącznie z nieaktywnymi). Etap 11: odjąć rezerwacje.
-- in_view: materiał pokazywany w „sumie per materiał” — ma stan > 0 albo jest poniżej minimum (stan 0 + minimum).
create view public.v_material_stock
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
  (m.active and m.min_quantity is not null and coalesce(t.total, 0) < m.min_quantity) as below_minimum,
  case
    when m.active and m.min_quantity is not null then greatest(m.min_quantity - coalesce(t.total, 0), 0)
    else 0
  end as shortage,
  (coalesce(t.total, 0) > 0
    or (m.active and m.min_quantity is not null and coalesce(t.total, 0) < m.min_quantity)) as in_view
from public.materials m
join public.material_categories c on c.id = m.category_id
left join public.suppliers sp on sp.id = m.default_supplier_id
left join lateral (
  select sum(s.quantity) as total, count(*) filter (where s.quantity > 0) as locations
  from public.stock s
  where s.material_id = m.id
) t on true;

revoke all on table public.v_material_stock from public, anon, authenticated, service_role;
grant select on table public.v_material_stock to authenticated, service_role;
grant select on table public.v_stock to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Statystyki dashboardu (ADMIN, BIURO) — jedno wywołanie, wszystko w SQL
-- ---------------------------------------------------------------------------
create index stock_operations_created_idx on public.stock_operations (created_at desc);

create function public.dashboard_stats()
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
      '{}'::jsonb)
  );
end;
$$;

revoke all on function public.dashboard_stats() from public, anon, authenticated, service_role;
grant execute on function public.dashboard_stats() to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Eksport stanów do CSV (ADMIN, BIURO) — jeden odczyt, bez limitu max_rows Data API
-- ---------------------------------------------------------------------------
-- p_variant: 'location' (materiał × lokalizacja, stan > 0) albo 'material' (suma per materiał).
-- Wyszukiwanie jak w widoku (kod/nazwa materiału, w wariancie 'location' także kod lokalizacji); znaki LIKE escapowane.
-- Twardy limit 50 000 wierszy (zabezpieczenie przed gigantyczną odpowiedzią).
create function public.export_stock_rows(
  p_variant text,
  p_q text default null,
  p_category_id uuid default null,
  p_below_min boolean default false
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_pattern text;
  v_result jsonb;
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
    select coalesce(jsonb_agg(to_jsonb(r) order by r.material_code, r.location_code), '[]'::jsonb)
    into v_result
    from (
      select
        v.material_code, v.material_name, c.name as category_name, v.unit,
        v.location_code, v.location_name, v.quantity
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
      limit 50000
    ) r;
  else
    select coalesce(jsonb_agg(to_jsonb(r) order by r.material_code), '[]'::jsonb)
    into v_result
    from (
      select
        v.material_code, v.material_name, v.category_name, v.unit,
        v.total_quantity, v.min_quantity, v.shortage, v.below_minimum,
        v.location_count, v.default_supplier_name
      from public.v_material_stock v
      where v.in_view
        and (p_category_id is null or v.category_id = p_category_id)
        and (not coalesce(p_below_min, false) or v.below_minimum)
        and (v_pattern is null or v.material_code ilike v_pattern or v.material_name ilike v_pattern)
      order by v.material_code
      limit 50000
    ) r;
  end if;
  return v_result;
end;
$$;

revoke all on function public.export_stock_rows(text, text, uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.export_stock_rows(text, text, uuid, boolean) to authenticated;
