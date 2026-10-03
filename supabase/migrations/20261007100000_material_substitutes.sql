-- Etap 12b: odpowiedniki (zamienniki) materiałów (ADR 017). Migracja addytywna.
--
--  * material_substitutes — pary odpowiedników (relacja SYMETRYCZNA, NIE przechodnia, przelicznik 1:1; para
--    kanoniczna material_a < material_b). Zarządza ADMIN funkcjami add/remove_material_substitute.
--  * stock_operations.substitute_for_material_id — rozliczenie zamiennika ZAPISANE przy wydaniu (audytowalność;
--    usunięcie pary nie zmienia przeszłości). stock_issue: nowy parametr p_substitute_for — zamiennik WYŁĄCZNIE
--    jawnie (bez automatu po stronie serwera; podpowiedź w UI); stock_reverse kopiuje rozliczenie na storno.
--  * reservation_events: nowy typ SUBSTITUTE_RELEASE (rezerwacja oryginału zmniejszona przy wydaniu zamiennika).
--  * app.requirement_balance: wydano(XXX) += operacje zlecenia z substitute_for = XXX (ilość YYY, 1:1); te operacje
--    NIE liczą się do wydano(YYY). Wszystkie funkcje oparte na bilansie dziedziczą zmianę.
--  * substitute_requirement_item — „Podmień” pozycję listy (wycofanie + poprawiona kopia, atomowo, idempotentnie).
--  * app.substitute_availability — odpowiedniki z wolnym stanem: order_shortages, order_to_issue, shortages_summary,
--    export_shortages_csv, resolve_import_codes (zmiana typu wyniku → DROP + CREATE z GRANT-ami).
--  * order_issue_summary, list_stock_movements — informacja „zamiennik za XXX”.
--
-- Kolejność blokad (ADR 010/011/014, rozszerzona w ADR 017):
--   advisory(client_request_id) → materiały FOR NO KEY UPDATE rosnąco po id (stock_issue: {YYY, jawny XXX};
--   substitute_requirement_item: {from, to}) → [Podmień: wiersz listy FOR UPDATE] → zlecenie FOR SHARE → lokalizacje
--   → wiersze stock → wiersze reservations FOR UPDATE.

-- ---------------------------------------------------------------------------
-- 1. Pary odpowiedników
-- ---------------------------------------------------------------------------
create table public.material_substitutes (
  id uuid primary key default gen_random_uuid(),
  -- Kaskada wyłącznie dla sprzątania testów (materiałów nie usuwa się w aplikacji).
  material_a uuid not null references public.materials (id) on delete cascade,
  material_b uuid not null references public.materials (id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id),
  -- Para kanoniczna (XXX↔YYY zapisane raz); wyklucza też parę materiału z samym sobą.
  constraint material_substitutes_canonical check (material_a < material_b),
  constraint material_substitutes_pair_key unique (material_a, material_b)
);

create index material_substitutes_b_idx on public.material_substitutes (material_b);

comment on table public.material_substitutes is
  'Odpowiedniki materiałów: para symetryczna (A↔B), nieprzechodnia, przelicznik 1:1. Konfiguracja (ADMIN) — usunięcie pary nie zmienia rozliczeń historycznych (stock_operations.substitute_for_material_id).';

alter table public.material_substitutes enable row level security;

-- Role aplikacyjne: tylko SELECT (każda aktywna rola). Zapis przez funkcje SECURITY DEFINER (ADMIN).
-- service_role: SELECT + DELETE — wyłącznie sprzątanie testów.
revoke all on table public.material_substitutes from public, anon, authenticated, service_role;
grant select on table public.material_substitutes to authenticated;
grant select, delete on table public.material_substitutes to service_role;

create policy material_substitutes_select on public.material_substitutes
  for select to authenticated using ((select app.user_role()) is not null);

-- Dodanie pary (ADMIN). Idempotentne: istniejąca para → already_existed = true. Blokuje oba materiały (rosnąco) —
-- serializuje z wydaniami, które czytają zbiór odpowiedników pod blokadą materiału.
create function public.add_material_substitute(p_material_id uuid, p_substitute_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.app_role := app.user_role();
  v_a uuid := least(p_material_id, p_substitute_id);
  v_b uuid := greatest(p_material_id, p_substitute_id);
  v_bad text;
  v_count integer;
  v_id uuid;
  v_existed boolean := false;
begin
  if auth.uid() is null or v_role is distinct from 'ADMIN' then
    raise exception 'Odpowiedniki materiałów zmienia wyłącznie administrator' using errcode = '42501';
  end if;
  if p_material_id is null or p_substitute_id is null then
    raise exception 'Wskaż oba materiały' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  if p_material_id = p_substitute_id then
    raise exception 'Materiał nie może być odpowiednikiem samego siebie' using errcode = 'P0001', hint = 'SAME_MATERIAL';
  end if;

  perform 1 from public.materials m where m.id in (v_a, v_b) order by m.id for no key update;
  select count(*) into v_count from public.materials m where m.id in (v_a, v_b);
  if v_count < 2 then
    raise exception 'Nie znaleziono materiału' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'material';
  end if;
  select m.code into v_bad from public.materials m where m.id in (v_a, v_b) and not m.active order by m.code limit 1;
  if v_bad is not null then
    raise exception 'Materiał jest nieaktywny' using errcode = 'P0001', hint = 'MATERIAL_INACTIVE', detail = v_bad;
  end if;

  insert into public.material_substitutes (material_a, material_b, created_by)
  values (v_a, v_b, auth.uid())
  on conflict (material_a, material_b) do nothing
  returning id into v_id;
  if v_id is null then
    select s.id into v_id from public.material_substitutes s where s.material_a = v_a and s.material_b = v_b;
    v_existed := true;
  end if;

  return jsonb_build_object('id', v_id, 'material_a', v_a, 'material_b', v_b, 'already_existed', v_existed);
end;
$$;
revoke all on function public.add_material_substitute(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.add_material_substitute(uuid, uuid) to authenticated;

-- Usunięcie pary (ADMIN). Konfiguracja — historia wydań zamienników zostaje (rozliczenie zapisane w operacji).
create function public.remove_material_substitute(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.app_role := app.user_role();
  v_pair public.material_substitutes%rowtype;
begin
  if auth.uid() is null or v_role is distinct from 'ADMIN' then
    raise exception 'Odpowiedniki materiałów zmienia wyłącznie administrator' using errcode = '42501';
  end if;
  select * into v_pair from public.material_substitutes s where s.id = p_id;
  if not found then
    raise exception 'Nie znaleziono pary odpowiedników' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'substitute';
  end if;
  perform 1 from public.materials m where m.id in (v_pair.material_a, v_pair.material_b) order by m.id for no key update;
  delete from public.material_substitutes s where s.id = p_id;
  if not found then
    raise exception 'Nie znaleziono pary odpowiedników' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'substitute';
  end if;
  return jsonb_build_object('id', p_id, 'material_a', v_pair.material_a, 'material_b', v_pair.material_b);
end;
$$;
revoke all on function public.remove_material_substitute(uuid) from public, anon, authenticated, service_role;
grant execute on function public.remove_material_substitute(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Odpowiedniki z wolnym stanem (jeden helper dla braków, importu, terminala)
-- ---------------------------------------------------------------------------
-- Per materiał: lista AKTYWNYCH odpowiedników {material_id, code, name, unit, allows_fraction, free, own_reserved,
-- available}, gdzie free = jak app.material_free (stan aktywnych lokalizacji − rezerwacje, min. 0), own_reserved =
-- rezerwacja zlecenia p_order_id na odpowiednik (0 bez zlecenia), available = free + own_reserved. Sortowanie:
-- available malejąco, kod. Materiał bez aktywnych odpowiedników — brak wiersza.
create function app.substitute_availability(p_material_ids uuid[], p_order_id uuid default null)
returns table (material_id uuid, substitutes jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  with ids as materialized (
    select distinct x.id from unnest(p_material_ids) as x(id) where x.id is not null
  ), pairs as materialized (
    select i.id as material_id, s.material_b as sub_id from ids i join public.material_substitutes s on s.material_a = i.id
    union
    select i.id, s.material_a from ids i join public.material_substitutes s on s.material_b = i.id
  ), fr as materialized (
    select * from app.material_free((select coalesce(array_agg(distinct p.sub_id), '{}') from pairs p))
  ), own as materialized (
    select r.material_id, r.quantity
    from public.reservations r
    where p_order_id is not null and r.production_order_id = p_order_id and r.quantity > 0
      and r.material_id in (select p.sub_id from pairs p)
  )
  select p.material_id,
         jsonb_agg(jsonb_build_object(
           'material_id', m.id, 'code', m.code, 'name', m.name, 'unit', m.unit, 'allows_fraction', m.allows_fraction,
           'free', coalesce(f.free, 0), 'own_reserved', coalesce(o.quantity, 0),
           'available', coalesce(f.free, 0) + coalesce(o.quantity, 0))
           order by coalesce(f.free, 0) + coalesce(o.quantity, 0) desc, m.code)
  from pairs p
  join public.materials m on m.id = p.sub_id and m.active
  left join fr f on f.material_id = p.sub_id
  left join own o on o.material_id = p.sub_id
  group by p.material_id
$$;
revoke all on function app.substitute_availability(uuid[], uuid) from public, anon, authenticated, service_role;

-- Karta materiału: wszystkie odpowiedniki (także nieaktywne — do usunięcia pary), z wolnym stanem. Każda aktywna rola.
create function public.material_substitute_list(p_material_id uuid)
returns table (
  id uuid, material_id uuid, material_code text, material_name text, unit text, active boolean,
  stock_active numeric, reserved numeric, free numeric, created_at timestamptz
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
    with pairs as materialized (
      select s.id, case when s.material_a = p_material_id then s.material_b else s.material_a end as sub_id, s.created_at
      from public.material_substitutes s
      where s.material_a = p_material_id or s.material_b = p_material_id
    ), fr as materialized (
      select * from app.material_free((select coalesce(array_agg(p.sub_id), '{}') from pairs p))
    )
    select p.id, m.id, m.code, m.name, m.unit, m.active, f.stock_active, f.reserved, f.free, p.created_at
    from pairs p
    join public.materials m on m.id = p.sub_id
    left join fr f on f.material_id = p.sub_id
    order by m.active desc, m.code;
end;
$$;
revoke all on function public.material_substitute_list(uuid) from public, anon, authenticated, service_role;
grant execute on function public.material_substitute_list(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. stock_operations: rozliczenie zamiennika (zapisane przy wydaniu)
-- ---------------------------------------------------------------------------
alter table public.stock_operations
  add column substitute_for_material_id uuid
    constraint stock_operations_substitute_for_fkey references public.materials (id);

-- Tylko wydanie / storno wydania na zlecenie. Materiał operacji jest w stock_movements — „≠ materiał operacji”
-- pilnuje trigger stock_movements_substitute_check.
alter table public.stock_operations
  add constraint stock_operations_substitute_valid check (
    substitute_for_material_id is null
    or (substitute_for_material_id is not null and type in ('ISSUE', 'REVERSAL') and production_order_id is not null)
  );

create index stock_operations_substitute_idx on public.stock_operations (substitute_for_material_id)
  where substitute_for_material_id is not null;

comment on column public.stock_operations.substitute_for_material_id is
  'Wydanie zamiennika (ISSUE/REVERSAL na zlecenie): materiał z zapotrzebowania (XXX), za który wydano materiał ruchu (YYY), 1:1. Bilans zlecenia liczy tę ilość do XXX.';

create function app.stock_movements_substitute_check()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.stock_operations o
    where o.id = new.operation_id and o.substitute_for_material_id = new.material_id
  ) then
    raise exception 'Zamiennik musi być innym materiałem niż oryginał' using errcode = 'P0001', hint = 'NOT_A_SUBSTITUTE';
  end if;
  return new;
end;
$$;
revoke all on function app.stock_movements_substitute_check() from public, anon, authenticated, service_role;

create trigger stock_movements_substitute_check
  before insert on public.stock_movements
  for each row execute function app.stock_movements_substitute_check();

-- ---------------------------------------------------------------------------
-- 4. reservation_events: SUBSTITUTE_RELEASE (operation_id + powód, bez request_id)
-- ---------------------------------------------------------------------------
alter table public.reservation_events drop constraint reservation_events_type_valid;
alter table public.reservation_events
  add constraint reservation_events_type_valid
  check (type in ('RESERVE', 'RELEASE', 'CONSUME', 'OVERRIDE', 'AUTO_RELEASE', 'SUBSTITUTE_RELEASE'));

alter table public.reservation_events drop constraint reservation_events_links;
alter table public.reservation_events
  add constraint reservation_events_links check (
    case type
      when 'RESERVE' then request_id is not null and operation_id is null
      when 'RELEASE' then request_id is not null and operation_id is null
      when 'CONSUME' then operation_id is not null and request_id is null
      when 'OVERRIDE' then operation_id is not null and request_id is null and reason is not null
      when 'SUBSTITUTE_RELEASE' then operation_id is not null and request_id is null and reason is not null
      else operation_id is null and request_id is null
    end
  );

comment on table public.reservation_events is
  'Historia rezerwacji (niemutowalna): RESERVE, RELEASE (ręczne), CONSUME (wydanie na zlecenie), OVERRIDE (ADMIN wydał mimo rezerwacji), AUTO_RELEASE (zlecenie zakończone/anulowane), SUBSTITUTE_RELEASE (wydano zamiennik — rezerwacja oryginału ponad nowe pozostało).';

-- ---------------------------------------------------------------------------
-- 5. Bilans zlecenia: zamienniki liczone do oryginału (poprzednia definicja: 20261003110000)
-- ---------------------------------------------------------------------------
-- Jedyna zmiana: w CTE iss materiał = coalesce(substitute_for_material_id, materiał ruchu). Agregacja nadal per
-- (zlecenie, materiał) w CTE MATERIALIZED (ADR 013 L1). Sygnatura bez zmian.
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
    select o.production_order_id, coalesce(o.substitute_for_material_id, mv.material_id) as material_id,
           -sum(mv.quantity_delta) as issued
    from public.stock_operations o
    join need_orders no on no.production_order_id = o.production_order_id
    join public.stock_movements mv on mv.operation_id = o.id
    where o.type in ('ISSUE', 'REVERSAL')
    group by o.production_order_id, coalesce(o.substitute_for_material_id, mv.material_id)
  )
  select n.production_order_id, n.material_id, n.needed,
         coalesce(s.issued, 0),
         greatest(n.needed - coalesce(s.issued, 0), 0)
  from need n
  left join iss s on s.production_order_id = n.production_order_id and s.material_id = n.material_id
$$;
revoke all on function app.requirement_balance(uuid[]) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Wydanie: stock_issue z zamiennikiem (poprzednia definicja: 20261004100000)
-- ---------------------------------------------------------------------------
-- Zmiany: parametr p_substitute_for (wartość domyślna — stare wywołania działają; stara sygnatura usunięta),
-- porównanie przy replay (jak override — wartość jawna), walidacja (zamiennik tylko na zlecenie, ≠ materiał),
-- blokady materiałów {YYY, XXX} rosnąco, kontrola zamiennika (NOT_A_SUBSTITUTE, NOT_IN_REQUIREMENTS, NOT_INTEGER dla
-- XXX bez ułamków), zapis kolumny, zdarzenie SUBSTITUTE_RELEASE, pola wyniku substitute_for /
-- substitute_reservation_released. Zamiennik WYŁĄCZNIE jawnie — bez automatu (ADR 017 H1). Reszta bez zmian.
drop function public.stock_issue(uuid, uuid, uuid, numeric, uuid, text, text, text, boolean, text);

create function public.stock_issue(
  p_client_request_id uuid,
  p_location_id uuid,
  p_material_id uuid,
  p_quantity numeric,
  p_production_order_id uuid default null,
  p_reason_code text default null,
  p_reason text default null,
  p_note text default null,
  p_override_reservations boolean default false,
  p_override_reason text default null,
  p_substitute_for uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role public.app_role := app.user_role();
  v_reason text := nullif(btrim(p_reason), '');
  v_note text := nullif(btrim(p_note), '');
  v_override boolean := coalesce(p_override_reservations, false);
  v_override_reason text := nullif(btrim(p_override_reason), '');
  v_op public.stock_operations%rowtype;
  v_mv public.stock_movements%rowtype;
  v_material record;
  v_order_status text;
  v_available numeric;
  v_remaining numeric;
  -- rezerwacje (Etap 11)
  v_stock_active numeric;
  v_reserved_all numeric;
  v_own numeric := 0;
  v_own_id uuid;
  v_free numeric;
  v_allowed numeric;
  v_take_others numeric := 0;
  v_consume numeric := 0;
  v_take numeric;
  v_res record;
  v_overridden jsonb := '[]'::jsonb;
  v_after numeric;
  -- zamiennik (Etap 12b)
  v_mats uuid[];
  v_sub uuid;
  v_sub_fraction boolean;
  v_sub_code text;
  v_sub_needed numeric;
  v_sub_issued numeric;
  v_sub_res_id uuid;
  v_sub_res numeric;
  v_sub_release numeric := 0;
  v_sub_info jsonb;
begin
  -- 1. Rola
  if v_uid is null or v_role is null or v_role not in ('PRODUKCJA', 'ADMIN') then
    raise exception 'Brak uprawnień do wydania towaru' using errcode = '42501';
  end if;
  -- Wydanie mimo rezerwacji innych zleceń — wyłącznie ADMIN (decyzja użytkownika, Etap 11).
  if v_override and v_role <> 'ADMIN' then
    raise exception 'Wydanie mimo rezerwacji może wykonać tylko ADMIN' using errcode = '42501';
  end if;
  if p_client_request_id is null then
    raise exception 'Brak identyfikatora żądania' using errcode = 'P0001', hint = 'VALIDATION';
  end if;

  -- 2. Idempotencja: advisory lock na id; ten sam użytkownik + te same parametry → replay (nawet jeśli zlecenie
  -- zostało w międzyczasie zamknięte — operacja już się odbyła). Zamiennik porównywany jak override.
  perform pg_advisory_xact_lock(hashtextextended('forbud.stock_op:' || p_client_request_id::text, 0));

  select * into v_op from public.stock_operations o where o.client_request_id = p_client_request_id;
  if found then
    select * into v_mv from public.stock_movements mv where mv.operation_id = v_op.id order by mv.id limit 1;
    if v_op.user_id <> v_uid
       or v_op.type <> 'ISSUE'
       or v_mv.material_id is distinct from p_material_id
       or v_mv.location_id is distinct from p_location_id
       or v_mv.quantity_delta is distinct from -p_quantity
       or v_op.production_order_id is distinct from p_production_order_id
       or v_op.reason_code is distinct from p_reason_code
       or v_op.reason is distinct from v_reason
       or v_op.note is distinct from v_note
       or v_op.override_reservations is distinct from v_override
       or v_op.override_reason is distinct from v_override_reason
       or v_op.substitute_for_material_id is distinct from p_substitute_for then
      raise exception 'Ten identyfikator żądania został już użyty dla innej operacji'
        using errcode = 'P0001', hint = 'IDEMPOTENCY_CONFLICT';
    end if;
    select s.quantity into v_remaining
    from public.stock s
    where s.material_id = v_mv.material_id and s.location_id = v_mv.location_id;
    return jsonb_build_object(
      'operation_id', v_op.id,
      'movement_id', v_mv.id,
      'material_id', v_mv.material_id,
      'location_id', v_mv.location_id,
      'quantity', -v_mv.quantity_delta,
      'production_order_id', v_op.production_order_id,
      'reason_code', v_op.reason_code,
      'remaining_location_quantity', coalesce(v_remaining, 0),
      'reservation_consumed', coalesce((
        select -sum(e.quantity_delta) from public.reservation_events e
        where e.operation_id = v_op.id and e.type = 'CONSUME'), 0),
      'reservations_overridden', coalesce((
        select jsonb_agg(jsonb_build_object('order_id', r.production_order_id, 'quantity', -e.quantity_delta) order by e.created_at, e.id)
        from public.reservation_events e join public.reservations r on r.id = e.reservation_id
        where e.operation_id = v_op.id and e.type = 'OVERRIDE'), '[]'::jsonb),
      'substitute_for', (
        select jsonb_build_object('material_id', m.id, 'code', m.code, 'name', m.name)
        from public.materials m where m.id = v_op.substitute_for_material_id),
      'substitute_reservation_released', coalesce((
        select -sum(e.quantity_delta) from public.reservation_events e
        where e.operation_id = v_op.id and e.type = 'SUBSTITUTE_RELEASE'), 0),
      'idempotent_replay', true
    );
  end if;

  -- 3. Walidacja wejścia (bez blokad): dokładnie jedno — zlecenie albo powód.
  if (p_production_order_id is null) = (p_reason_code is null) then
    raise exception 'Wybierz zlecenie albo powód wydania (dokładnie jedno)' using errcode = 'P0001', hint = 'ISSUE_TARGET';
  end if;
  if p_reason_code is not null
     and p_reason_code not in ('SERWIS', 'USZKODZENIE', 'ZUZYCIE_WLASNE', 'PROBKA', 'INNY') then
    raise exception 'Nieprawidłowy powód wydania' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  if p_production_order_id is not null and v_reason is not null then
    raise exception 'Opis powodu podaje się tylko przy wydaniu bez zlecenia' using errcode = 'P0001', hint = 'ISSUE_TARGET';
  end if;
  if p_reason_code = 'INNY' and v_reason is null then
    raise exception 'Opisz powód wydania' using errcode = 'P0001', hint = 'REASON_REQUIRED';
  end if;
  if length(v_reason) > 200 or length(v_note) > 500 then
    raise exception 'Opis powodu do 200 znaków, notatka do 500 znaków' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  if v_override and (v_override_reason is null or length(v_override_reason) < 3) then
    raise exception 'Podaj powód wydania mimo rezerwacji (co najmniej 3 znaki)' using errcode = 'P0001', hint = 'REASON_REQUIRED';
  end if;
  if not v_override and v_override_reason is not null then
    raise exception 'Powód pominięcia rezerwacji podaje się tylko przy wydaniu mimo rezerwacji' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  if length(v_override_reason) > 200 then
    raise exception 'Powód pominięcia rezerwacji do 200 znaków' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  if p_quantity is null or p_quantity <= 0 or p_quantity > 1000000 or p_quantity <> round(p_quantity, 3) then
    raise exception 'Ilość musi być większa od zera, maksymalnie 1 000 000, do 3 miejsc po przecinku'
      using errcode = 'P0001', hint = 'INVALID_QUANTITY';
  end if;
  if p_substitute_for is not null and p_production_order_id is null then
    raise exception 'Zamiennik wskazuje się tylko przy wydaniu na zlecenie' using errcode = 'P0001', hint = 'ISSUE_TARGET';
  end if;
  if p_substitute_for = p_material_id then
    raise exception 'Zamiennik musi być innym materiałem niż oryginał' using errcode = 'P0001', hint = 'NOT_A_SUBSTITUTE';
  end if;

  -- 4. Blokady (ADR 010/014/017): materiały → zlecenie → wiersz stanu → wiersze rezerwacji.
  -- Materiały: wydawany YYY i jawny oryginał XXX, FOR NO KEY UPDATE rosnąco po id (jak każda funkcja
  -- wielomateriałowa — bez cyklu). Blokada XXX serializuje wydanie zamiennika z „Podmień” i z wydaniami XXX.
  select array_agg(distinct x.id order by x.id) into v_mats
  from unnest(array[p_material_id, p_substitute_for]) as x(id)
  where x.id is not null;

  perform 1 from public.materials m where m.id = any (v_mats) order by m.id for no key update;

  select m.id, m.allows_fraction, m.code into v_material
  from public.materials m
  where m.id = p_material_id;
  if not found then
    raise exception 'Nie znaleziono materiału' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'material';
  end if;
  if not v_material.allows_fraction and p_quantity <> trunc(p_quantity) then
    raise exception 'Ten materiał wydaje się w całych jednostkach' using errcode = 'P0001', hint = 'NOT_INTEGER';
  end if;

  -- Zlecenie FOR SHARE: koliduje z UPDATE zlecenia (zmiana statusu), więc zamknięcie zlecenia czeka na koniec
  -- wydania, a wydanie rozpoczęte po zamknięciu widzi status DONE/CANCELLED. Równoległe wydania na to samo
  -- zlecenie się nie blokują (FOR SHARE jest współdzielone).
  if p_production_order_id is not null then
    select po.status into v_order_status
    from public.production_orders po
    where po.id = p_production_order_id
    for share;
    if not found then
      raise exception 'Nie znaleziono zlecenia' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'order';
    end if;
    if v_order_status not in ('OPEN', 'IN_PRODUCTION') then
      raise exception 'Zlecenie jest zakończone lub anulowane — nie można na nie wydawać' using errcode = 'P0001', hint = 'ORDER_NOT_OPEN';
    end if;

    -- 4b. Zamiennik (Etap 12b). Bilans liczony pod blokadą materiałów (wydania tych materiałów są serializowane).
    if p_substitute_for is not null then
      if not exists (
        select 1 from public.material_substitutes s
        where s.material_a = least(p_material_id, p_substitute_for) and s.material_b = greatest(p_material_id, p_substitute_for)
      ) then
        raise exception 'Materiały nie są odpowiednikami' using errcode = 'P0001', hint = 'NOT_A_SUBSTITUTE';
      end if;
      if not exists (
        select 1 from public.requirements r
        join public.requirement_items i on i.requirement_id = r.id
        where r.production_order_id = p_production_order_id and r.status = 'ACTIVE' and i.material_id = p_substitute_for
      ) then
        raise exception 'Oryginał nie występuje w zapotrzebowaniu zlecenia' using errcode = 'P0001', hint = 'NOT_IN_REQUIREMENTS',
          detail = (select m.code from public.materials m where m.id = p_substitute_for);
      end if;
      v_sub := p_substitute_for;
      select m.allows_fraction, m.code into v_sub_fraction, v_sub_code from public.materials m where m.id = v_sub;
      -- Oryginał bez ułamków: rozliczenie 1:1 nie może dać mu ułamkowego „wydano” (M2c).
      if not v_sub_fraction and p_quantity <> trunc(p_quantity) then
        raise exception 'Oryginał liczy się w całych jednostkach — zamiennik wydaj w całych jednostkach'
          using errcode = 'P0001', hint = 'NOT_INTEGER', detail = v_sub_code;
      end if;
      -- Jeden odczyt bilansu oryginału (pod blokadą XXX — wydania XXX i jego zamienników są serializowane).
      select b.needed, b.issued into v_sub_needed, v_sub_issued
      from app.requirement_balance(array[p_production_order_id]) b
      where b.material_id = v_sub;
    end if;
  end if;

  -- Lokalizacja: tylko istnienie (nieaktywna dozwolona; wydanie nie zwiększa stanu, więc nie koliduje
  -- z blokadą dezaktywacji LOCATION_NOT_EMPTY).
  if not exists (select 1 from public.locations l where l.id = p_location_id) then
    raise exception 'Nie znaleziono lokalizacji' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'location';
  end if;

  select s.quantity into v_available
  from public.stock s
  where s.material_id = p_material_id and s.location_id = p_location_id
  for update;
  v_available := coalesce(v_available, 0);

  -- 5. Dostępność w lokalizacji.
  if p_quantity > v_available then
    raise exception 'Niewystarczający stan w lokalizacji' using errcode = 'P0001', hint = 'INSUFFICIENT_STOCK',
      detail = v_available::text;
  end if;

  -- 5b. Rezerwacje (Etap 11). Wiersze rezerwacji materiału FOR UPDATE rosnąco po zleceniu (po blokadzie materiału
  -- nikt nie może ich zwiększyć; auto-zwolnienie może je tylko zmniejszyć). Wolne = max(stan w aktywnych
  -- lokalizacjach − Σ rezerwacji, 0). Wydanie na zlecenie X: ≤ wolne + rezerwacja X; inne wydania: ≤ wolne.
  perform 1
  from public.reservations r
  where r.material_id = p_material_id and r.quantity > 0
  order by r.production_order_id
  for update;

  select coalesce(sum(s.quantity), 0) into v_stock_active
  from public.stock s
  join public.locations l on l.id = s.location_id and l.active
  where s.material_id = p_material_id;
  select coalesce(sum(r.quantity), 0) into v_reserved_all
  from public.reservations r
  where r.material_id = p_material_id and r.quantity > 0;
  if p_production_order_id is not null then
    select r.id, r.quantity into v_own_id, v_own
    from public.reservations r
    where r.material_id = p_material_id and r.production_order_id = p_production_order_id;
    v_own := coalesce(v_own, 0);
  end if;
  v_free := greatest(v_stock_active - v_reserved_all, 0);
  v_allowed := v_free + v_own;

  if p_quantity > v_allowed then
    if not v_override then
      raise exception 'Towar jest zarezerwowany dla innych zleceń' using errcode = 'P0001', hint = 'RESERVED_STOCK',
        detail = jsonb_build_object(
          'free', v_free,
          'own_reserved', v_own,
          'reserved_others', v_reserved_all - v_own,
          'orders', coalesce((
            select jsonb_agg(jsonb_build_object('order_id', x.id, 'number', x.number, 'name', x.name, 'quantity', x.quantity)
                             order by x.quantity desc, x.name)
            from (
              select po.id, po.number, po.name, r.quantity
              from public.reservations r
              join public.production_orders po on po.id = r.production_order_id
              where r.material_id = p_material_id and r.quantity > 0
                and r.production_order_id is distinct from p_production_order_id
              order by r.quantity desc, po.name
              limit 10
            ) x), '[]'::jsonb)
        )::text;
    end if;
    v_take_others := p_quantity - v_allowed;
  end if;
  v_consume := least(p_quantity, v_own);

  -- 5c. Rezerwacja oryginału XXX na tym zleceniu (zamiennik): wiersz (X, XXX) FOR UPDATE. Wiersze rezerwacji XXX
  -- zmienia wyłącznie ktoś z blokadą materiału XXX (trzymamy ją) albo auto-zwolnienie zlecenia X (wykluczone przez
  -- FOR SHARE na zleceniu) — ta blokada nigdy nie czeka.
  if v_sub is not null then
    select r.id, r.quantity into v_sub_res_id, v_sub_res
    from public.reservations r
    where r.production_order_id = p_production_order_id and r.material_id = v_sub
    for update;
    -- Nowe pozostało XXX po wydaniu = max(potrzebne − (wydano + ilość), 0); rezerwacja ponad nie → zmniejszenie,
    -- najwyżej o ilość wydania (L2: nadmiar sprzed wydania zostaje dla „Zwolnij nadmiar”).
    v_sub_release := least(p_quantity, greatest(
      coalesce(v_sub_res, 0) - greatest(coalesce(v_sub_needed, 0) - coalesce(v_sub_issued, 0) - p_quantity, 0), 0));
  end if;

  -- 6. Zapis (flaga zapisu obejmuje historię i stan; zerowana zaraz potem). CHECK (quantity >= 0) na stock
  -- jest ostatnią barierą.
  perform set_config('forbud.stock_write', 'on', true);

  insert into public.stock_operations (type, user_id, client_request_id, production_order_id, reason_code, reason, note,
                                       override_reservations, override_reason, substitute_for_material_id)
  values ('ISSUE', v_uid, p_client_request_id, p_production_order_id, p_reason_code, v_reason, v_note,
          v_override, v_override_reason, v_sub)
  returning * into v_op;

  insert into public.stock_movements (operation_id, material_id, location_id, quantity_delta, user_id, created_at)
  values (v_op.id, p_material_id, p_location_id, -p_quantity, v_uid, v_op.created_at)
  returning * into v_mv;

  update public.stock s
  set quantity = s.quantity - p_quantity, updated_at = now()
  where s.material_id = p_material_id and s.location_id = p_location_id
  returning s.quantity into v_remaining;

  perform set_config('forbud.stock_write', '', true);

  -- 6b. Rozliczenie rezerwacji: najpierw własna (CONSUME), potem — tylko ADMIN z override — rezerwacje innych
  -- zleceń od najnowszej (LIFO po last_reserved_at) aż do pokrycia brakującej ilości (OVERRIDE z powodem);
  -- na końcu zamiennik: rezerwacja oryginału ponad nowe pozostało (SUBSTITUTE_RELEASE).
  if v_consume > 0 or v_take_others > 0 or v_sub_release > 0 then
    perform set_config('forbud.reservation_write', 'on', true);

    if v_consume > 0 then
      update public.reservations r
      set quantity = r.quantity - v_consume, updated_at = now()
      where r.id = v_own_id
      returning r.quantity into v_after;
      insert into public.reservation_events (reservation_id, type, quantity_delta, quantity_after, operation_id, user_id, created_at)
      values (v_own_id, 'CONSUME', -v_consume, v_after, v_op.id, v_uid, v_op.created_at);
    end if;

    if v_take_others > 0 then
      for v_res in
        select r.id, r.production_order_id, r.quantity
        from public.reservations r
        where r.material_id = p_material_id and r.quantity > 0
          and r.production_order_id is distinct from p_production_order_id
        order by r.last_reserved_at desc, r.id desc
      loop
        exit when v_take_others <= 0;
        v_take := least(v_res.quantity, v_take_others);
        update public.reservations r
        set quantity = r.quantity - v_take, updated_at = now()
        where r.id = v_res.id
        returning r.quantity into v_after;
        insert into public.reservation_events (reservation_id, type, quantity_delta, quantity_after, operation_id, reason, user_id, created_at)
        values (v_res.id, 'OVERRIDE', -v_take, v_after, v_op.id, v_override_reason, v_uid, v_op.created_at);
        v_overridden := v_overridden || jsonb_build_object('order_id', v_res.production_order_id, 'quantity', v_take);
        v_take_others := v_take_others - v_take;
      end loop;
    end if;

    if v_sub_release > 0 then
      update public.reservations r
      set quantity = r.quantity - v_sub_release, updated_at = now()
      where r.id = v_sub_res_id
      returning r.quantity into v_after;
      insert into public.reservation_events (reservation_id, type, quantity_delta, quantity_after, operation_id, reason, user_id, created_at)
      values (v_sub_res_id, 'SUBSTITUTE_RELEASE', -v_sub_release, v_after, v_op.id,
              left('Użyto zamiennika ' || v_material.code, 200), v_uid, v_op.created_at);
    end if;

    perform set_config('forbud.reservation_write', '', true);
  end if;

  if v_sub is not null then
    select jsonb_build_object('material_id', m.id, 'code', m.code, 'name', m.name) into v_sub_info
    from public.materials m where m.id = v_sub;
  end if;

  return jsonb_build_object(
    'operation_id', v_op.id,
    'movement_id', v_mv.id,
    'material_id', p_material_id,
    'location_id', p_location_id,
    'quantity', p_quantity,
    'production_order_id', p_production_order_id,
    'reason_code', p_reason_code,
    'remaining_location_quantity', v_remaining,
    'reservation_consumed', v_consume,
    'reservations_overridden', v_overridden,
    'substitute_for', v_sub_info,
    'substitute_reservation_released', v_sub_release,
    'idempotent_replay', false
  );
end;
$$;

revoke all on function public.stock_issue(uuid, uuid, uuid, numeric, uuid, text, text, text, boolean, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.stock_issue(uuid, uuid, uuid, numeric, uuid, text, text, text, boolean, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Storno: kopiuje rozliczenie zamiennika (poprzednia definicja: 20261002120000)
-- ---------------------------------------------------------------------------
-- Jedyna zmiana: INSERT operacji REVERSAL kopiuje substitute_for_material_id (jak zlecenie), więc
-- storno wydania zamiennika zwiększa „pozostało” oryginału. Rezerwacje nie są odtwarzane (ADR 014). Sygnatura bez
-- zmian — create or replace zachowuje uprawnienia.
create or replace function public.stock_reverse(
  p_client_request_id uuid,
  p_operation_id uuid,
  p_reason text,
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
  v_reason text := nullif(btrim(p_reason), '');
  v_note text := nullif(btrim(p_note), '');
  v_op public.stock_operations%rowtype;
  v_orig public.stock_operations%rowtype;
  v_row record;
  v_current numeric;
  v_items jsonb;
begin
  -- 1. Rola
  if v_uid is null or v_role is null or v_role <> 'ADMIN' then
    raise exception 'Cofnąć operację może wyłącznie administrator' using errcode = '42501';
  end if;
  if p_client_request_id is null or p_operation_id is null then
    raise exception 'Brak identyfikatora żądania lub operacji' using errcode = 'P0001', hint = 'VALIDATION';
  end if;

  -- 2. Idempotencja
  perform pg_advisory_xact_lock(hashtextextended('forbud.stock_op:' || p_client_request_id::text, 0));

  select * into v_op from public.stock_operations o where o.client_request_id = p_client_request_id;
  if found then
    if v_op.user_id <> v_uid
       or v_op.type <> 'REVERSAL'
       or v_op.reverses_operation_id is distinct from p_operation_id
       or v_op.reason is distinct from v_reason
       or v_op.note is distinct from v_note then
      raise exception 'Ten identyfikator żądania został już użyty dla innej operacji'
        using errcode = 'P0001', hint = 'IDEMPOTENCY_CONFLICT';
    end if;
    select coalesce(jsonb_agg(jsonb_build_object(
             'material_id', mv.material_id,
             'location_id', mv.location_id,
             'quantity_delta', mv.quantity_delta,
             'new_quantity', coalesce(s.quantity, 0)
           ) order by mv.material_id, mv.location_id), '[]'::jsonb)
      into v_items
    from public.stock_movements mv
    left join public.stock s on s.material_id = mv.material_id and s.location_id = mv.location_id
    where mv.operation_id = v_op.id;
    return jsonb_build_object(
      'operation_id', v_op.id,
      'reversed_operation_id', p_operation_id,
      'movements', v_items,
      'idempotent_replay', true
    );
  end if;

  -- 3. Walidacja wejścia
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'Podaj powód cofnięcia (co najmniej 3 znaki)' using errcode = 'P0001', hint = 'REASON_REQUIRED';
  end if;
  if length(v_reason) > 200 or length(v_note) > 500 then
    raise exception 'Powód do 200 znaków, notatka do 500 znaków' using errcode = 'P0001', hint = 'VALIDATION';
  end if;

  -- 4. Oryginał FOR NO KEY UPDATE — serializuje równoległe próby cofnięcia tej samej operacji (druga po
  -- uzyskaniu blokady widzi zatwierdzone storno → ALREADY_REVERSED). Nie koliduje z FOR KEY SHARE (FK).
  select * into v_orig
  from public.stock_operations o
  where o.id = p_operation_id
  for no key update;
  if not found then
    raise exception 'Nie znaleziono operacji' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'operation';
  end if;
  if v_orig.type = 'REVERSAL' then
    raise exception 'Nie można cofnąć cofnięcia' using errcode = 'P0001', hint = 'NOT_REVERSIBLE';
  end if;
  if exists (select 1 from public.stock_operations o where o.reverses_operation_id = p_operation_id) then
    raise exception 'Ta operacja została już cofnięta' using errcode = 'P0001', hint = 'ALREADY_REVERSED';
  end if;

  -- 5. Blokady w stałej kolejności: materiały (rosnąco po id) → lokalizacje (rosnąco po id) → wiersze stanu.
  perform 1
  from public.materials m
  where m.id in (select mv.material_id from public.stock_movements mv where mv.operation_id = p_operation_id)
  order by m.id
  for no key update;

  perform 1
  from public.locations l
  where l.id in (select mv.location_id from public.stock_movements mv where mv.operation_id = p_operation_id)
  order by l.id
  for share;

  perform 1
  from public.stock s
  join (select distinct mv.material_id, mv.location_id
        from public.stock_movements mv where mv.operation_id = p_operation_id) x
    on x.material_id = s.material_id and x.location_id = s.location_id
  order by s.material_id, s.location_id
  for update of s;

  -- 6. Kontrola: zmiana odwrotna per (materiał, lokalizacja).
  for v_row in
    select mv.material_id, mv.location_id, -sum(mv.quantity_delta) as delta,
           m.active as material_active, l.active as location_active, l.code as location_code
    from public.stock_movements mv
    join public.materials m on m.id = mv.material_id
    join public.locations l on l.id = mv.location_id
    where mv.operation_id = p_operation_id
    group by mv.material_id, mv.location_id, m.active, l.active, l.code
    order by mv.material_id, mv.location_id
  loop
    if v_row.delta > 0 and not v_row.material_active then
      raise exception 'Materiał jest nieaktywny — cofnięcie zwiększyłoby jego stan' using errcode = 'P0001',
        hint = 'MATERIAL_INACTIVE';
    end if;
    if v_row.delta > 0 and not v_row.location_active then
      raise exception 'Lokalizacja % jest nieaktywna — cofnięcie zwiększyłoby jej stan', v_row.location_code
        using errcode = 'P0001', hint = 'LOCATION_INACTIVE', detail = v_row.location_code;
    end if;
    if v_row.delta < 0 then
      select s.quantity into v_current
      from public.stock s
      where s.material_id = v_row.material_id and s.location_id = v_row.location_id;
      v_current := coalesce(v_current, 0);
      if v_current + v_row.delta < 0 then
        raise exception 'Niewystarczający stan w lokalizacji % — nie można cofnąć', v_row.location_code
          using errcode = 'P0001', hint = 'INSUFFICIENT_STOCK',
          detail = jsonb_build_object('available', v_current, 'location_code', v_row.location_code)::text;
      end if;
    end if;
  end loop;

  -- 7. Zapis: operacja REVERSAL (zlecenie i rozliczenie zamiennika z oryginału) + ruchy odwrotne + stany.
  perform set_config('forbud.stock_write', 'on', true);

  insert into public.stock_operations (type, user_id, client_request_id, production_order_id, reverses_operation_id, reason, note,
                                       substitute_for_material_id)
  values ('REVERSAL', v_uid, p_client_request_id, v_orig.production_order_id, p_operation_id, v_reason, v_note,
          v_orig.substitute_for_material_id)
  returning * into v_op;

  insert into public.stock_movements (operation_id, material_id, location_id, quantity_delta, user_id, created_at)
  select v_op.id, mv.material_id, mv.location_id, -mv.quantity_delta, v_uid, v_op.created_at
  from public.stock_movements mv
  where mv.operation_id = p_operation_id
  order by mv.material_id, mv.location_id;

  -- Istniejące wiersze: UPDATE (także zmniejszenie). Brakujące: INSERT — tylko zwiększenie (zmniejszenie bez
  -- wiersza odrzuciła kontrola w kroku 6). Nie przez INSERT … ON CONFLICT: CHECK (quantity >= 0) sprawdza
  -- proponowany wiersz przed rozstrzygnięciem konfliktu. Materiały zablokowane — brak równoległego INSERT.
  update public.stock s
  set quantity = s.quantity + x.delta, updated_at = now()
  from (
    select mv.material_id, mv.location_id, -sum(mv.quantity_delta) as delta
    from public.stock_movements mv
    where mv.operation_id = p_operation_id
    group by mv.material_id, mv.location_id
  ) x
  where s.material_id = x.material_id and s.location_id = x.location_id;

  insert into public.stock (material_id, location_id, quantity, updated_at)
  select x.material_id, x.location_id, x.delta, now()
  from (
    select mv.material_id, mv.location_id, -sum(mv.quantity_delta) as delta
    from public.stock_movements mv
    where mv.operation_id = p_operation_id
    group by mv.material_id, mv.location_id
  ) x
  where not exists (
    select 1 from public.stock s where s.material_id = x.material_id and s.location_id = x.location_id
  )
  order by x.material_id, x.location_id;

  perform set_config('forbud.stock_write', '', true);

  select coalesce(jsonb_agg(jsonb_build_object(
           'material_id', mv.material_id,
           'location_id', mv.location_id,
           'quantity_delta', mv.quantity_delta,
           'new_quantity', coalesce(s.quantity, 0)
         ) order by mv.material_id, mv.location_id), '[]'::jsonb)
    into v_items
  from public.stock_movements mv
  left join public.stock s on s.material_id = mv.material_id and s.location_id = mv.location_id
  where mv.operation_id = v_op.id;

  return jsonb_build_object(
    'operation_id', v_op.id,
    'reversed_operation_id', p_operation_id,
    'movements', v_items,
    'idempotent_replay', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. „Podmień” pozycję zapotrzebowania na odpowiednik (BIURO, ADMIN)
-- ---------------------------------------------------------------------------
-- 8a. Rdzeń list (poprzednia definicja: 20261006100000) + p_allow_inactive: materiały dozwolone mimo nieaktywności
-- (WYŁĄCZNIE pozycje kopiowane z listy źródłowej przy „Podmień”). create_requirement / import_requirement wołają rdzeń
-- z 8 argumentami (p_allow_inactive = NULL) — zachowanie bez zmian. Zmiana sygnatury → DROP + CREATE.
drop function app.create_requirement_core(uuid, text, text, jsonb, uuid, text, text, text);

create function app.create_requirement_core(
  p_order_id uuid,
  p_scope text,
  p_name text,
  p_items jsonb,
  p_client_request_id uuid,
  p_source text,
  p_file_name text,
  p_import_format text,
  p_allow_inactive uuid[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_name text := btrim(p_name);
  v_file text := btrim(p_file_name);
  v_format text := btrim(p_import_format);
  v_status text;
  v_req public.requirements%rowtype;
  v_count integer;
  v_distinct integer;
  v_bad text;
  v_hash text;
begin
  if p_source is null or p_source not in ('MANUAL', 'IMPORT') then
    raise exception 'Nieprawidłowe źródło listy' using errcode = 'P0001', hint = 'VALIDATION';
  end if;

  perform app.requirement_check_shape(p_items);
  v_hash := app.requirement_request_hash(p_scope, v_name, p_items, p_source, v_file, v_format);

  if p_client_request_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('forbud.requirement:' || p_client_request_id::text, 0));
    select * into v_req from public.requirements r where r.client_request_id = p_client_request_id;
    if found then
      if v_req.created_by is distinct from v_uid or v_req.request_hash is distinct from v_hash then
        raise exception 'Ten identyfikator żądania został już użyty dla innej listy' using errcode = 'P0001', hint = 'IDEMPOTENCY_CONFLICT';
      end if;
      return jsonb_build_object(
        'requirement_id', v_req.id,
        'order_id', v_req.production_order_id,
        'item_count', (select count(*) from public.requirement_items i where i.requirement_id = v_req.id),
        'idempotent_replay', true
      );
    end if;
  end if;

  if v_name is null or length(v_name) not between 1 and 120 then
    raise exception 'Nazwa listy: 1–120 znaków' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  if p_source = 'IMPORT' and (
       v_file is null or length(v_file) not between 1 and 255 or v_format is null or length(v_format) not between 1 and 100) then
    raise exception 'Import: nazwa pliku 1–255 i format 1–100 znaków' using errcode = 'P0001', hint = 'VALIDATION';
  end if;

  select count(*), count(distinct x.material_id) into v_count, v_distinct
  from jsonb_to_recordset(p_items) as x(material_id uuid, quantity numeric, note text, raw_source_ref text);
  if exists (select 1 from jsonb_to_recordset(p_items) as x(material_id uuid, quantity numeric, note text, raw_source_ref text) where x.material_id is null) then
    raise exception 'Pozycja bez materiału' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  if v_distinct < v_count then
    raise exception 'Ten sam materiał występuje na liście więcej niż raz' using errcode = 'P0001', hint = 'DUPLICATE_MATERIAL';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_items) as x(material_id uuid, quantity numeric, note text, raw_source_ref text)
    where x.quantity is null or x.quantity <= 0 or x.quantity > 1000000 or x.quantity <> round(x.quantity, 3)
  ) then
    raise exception 'Ilość musi być większa od zera, maksymalnie 1 000 000, do 3 miejsc po przecinku'
      using errcode = 'P0001', hint = 'INVALID_QUANTITY';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_items) as x(material_id uuid, quantity numeric, note text, raw_source_ref text)
    where length(btrim(x.note)) > 200 or length(btrim(x.raw_source_ref)) > 200
  ) then
    raise exception 'Notatka pozycji i odwołanie do pliku: do 200 znaków' using errcode = 'P0001', hint = 'VALIDATION';
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
    select 1 from jsonb_to_recordset(p_items) as x(material_id uuid, quantity numeric, note text, raw_source_ref text)
    where not exists (select 1 from public.materials m where m.id = x.material_id)
  ) then
    raise exception 'Nie znaleziono materiału' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'material';
  end if;
  select m.code into v_bad
  from jsonb_to_recordset(p_items) as x(material_id uuid, quantity numeric, note text, raw_source_ref text)
  join public.materials m on m.id = x.material_id
  where not m.active and not (m.id = any (coalesce(p_allow_inactive, '{}')))
  order by m.code limit 1;
  if v_bad is not null then
    raise exception 'Materiał jest nieaktywny' using errcode = 'P0001', hint = 'MATERIAL_INACTIVE', detail = v_bad;
  end if;
  select m.code into v_bad
  from jsonb_to_recordset(p_items) as x(material_id uuid, quantity numeric, note text, raw_source_ref text)
  join public.materials m on m.id = x.material_id
  where not m.allows_fraction and x.quantity <> trunc(x.quantity)
  order by m.code limit 1;
  if v_bad is not null then
    raise exception 'Ten materiał liczy się w całych jednostkach' using errcode = 'P0001', hint = 'NOT_INTEGER', detail = v_bad;
  end if;

  insert into public.requirements (production_order_id, source, name, imported_file_name, import_format, client_request_id, request_hash)
  values (
    p_order_id, p_source, v_name,
    case when p_source = 'IMPORT' then v_file end,
    case when p_source = 'IMPORT' then v_format end,
    p_client_request_id, v_hash)
  returning * into v_req;

  insert into public.requirement_items (requirement_id, material_id, quantity, note, raw_source_ref)
  select v_req.id, x.material_id, x.quantity, nullif(btrim(x.note), ''),
         case when p_source = 'IMPORT' then nullif(btrim(x.raw_source_ref), '') end
  from jsonb_to_recordset(p_items) as x(material_id uuid, quantity numeric, note text, raw_source_ref text);

  return jsonb_build_object('requirement_id', v_req.id, 'order_id', p_order_id, 'item_count', v_count, 'idempotent_replay', false);
end;
$$;
revoke all on function app.create_requirement_core(uuid, text, text, jsonb, uuid, text, text, text, uuid[]) from public, anon, authenticated, service_role;

-- 8b. substitute_requirement_item
-- Atomowo: wycofuje listę (powód „Podmiana XXX → YYY” + opcjonalny dopisek, ≤ 200) i tworzy jej kopię (ta sama
-- nazwa, źródło, plik, format; pozostałe pozycje bez zmian, z raw_source_ref — także materiały nieaktywne, bo to kopia
-- istniejącej listy) przez wspólny rdzeń app.create_requirement_core, z pozycją XXX zamienioną na YYY 1:1 (YYY już na
-- liście → suma; notatka „zamiennik za XXX”). Część XXX JUŻ WYDANA na zlecenie (wydano XXX ponad zapotrzebowanie
-- innych list ACTIVE, wraz z wydaniami zamienników za XXX; dla XXX bez ułamków zaokrąglona w górę) zostaje na kopii
-- jako XXX (decyzja implementera, ADR 017); gdy YYY jest bez ułamków, a XXX z ułamkami — na YYY przechodzi część
-- całkowita (floor), ułamek zostaje jako XXX. Całość wydana → NOTHING_TO_SUBSTITUTE. Rezerwacje XXX zostają (ADR 014
-- M1b — „Zwolnij nadmiar”). Idempotencja po p_client_request_id (= client_request_id nowej listy; odcisk liczony
-- z zapisanych pozycji nowej listy i parametrów podmiany).
-- Blokady (M1): advisory(crid) → materiały {from, to} FOR NO KEY UPDATE rosnąco → wiersz listy FOR UPDATE → zlecenie
-- FOR SHARE. Wydanie zamiennika blokuje XXX, więc „Podmień” i wydanie XXX / zamiennika za XXX są serializowane —
-- podział liczony z aktualnego bilansu.
create function public.substitute_requirement_item(
  p_client_request_id uuid,
  p_requirement_id uuid,
  p_from_material uuid,
  p_to_material uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role public.app_role := app.user_role();
  v_reason text := nullif(btrim(p_reason), '');
  v_scope text;
  v_hash text;
  v_new public.requirements%rowtype;
  v_req public.requirements%rowtype;
  v_item public.requirement_items%rowtype;
  v_from record;
  v_to record;
  v_status text;
  v_bal record;
  v_keep numeric;
  v_move numeric;
  v_items jsonb;
  v_keep_inactive uuid[];
  v_res jsonb;
begin
  if v_uid is null or v_role is null or v_role not in ('ADMIN', 'BIURO') then
    raise exception 'Brak uprawnień do podmiany pozycji zapotrzebowania' using errcode = '42501';
  end if;
  if p_client_request_id is null or p_requirement_id is null or p_from_material is null or p_to_material is null then
    raise exception 'Brak identyfikatora żądania, listy lub materiału' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  if p_from_material = p_to_material then
    raise exception 'Zamiennik musi być innym materiałem niż oryginał' using errcode = 'P0001', hint = 'NOT_A_SUBSTITUTE';
  end if;
  if length(v_reason) > 200 then
    raise exception 'Powód do 200 znaków' using errcode = 'P0001', hint = 'VALIDATION';
  end if;

  v_scope := 'SUBST:' || p_requirement_id::text || '|' || p_from_material::text || '|' || p_to_material::text || '|' || coalesce(v_reason, '');

  -- Idempotencja (ten sam klucz advisory co rdzeń list — blokada jest wielokrotnego wejścia w sesji).
  perform pg_advisory_xact_lock(hashtextextended('forbud.requirement:' || p_client_request_id::text, 0));
  select * into v_new from public.requirements r where r.client_request_id = p_client_request_id;
  if found then
    v_hash := app.requirement_request_hash(
      v_scope, v_new.name,
      (select jsonb_agg(jsonb_build_object('material_id', i.material_id, 'quantity', i.quantity, 'note', i.note,
                                           'raw_source_ref', i.raw_source_ref))
       from public.requirement_items i where i.requirement_id = v_new.id),
      v_new.source, v_new.imported_file_name, v_new.import_format);
    if v_new.created_by is distinct from v_uid or v_new.request_hash is distinct from v_hash then
      raise exception 'Ten identyfikator żądania został już użyty dla innej listy' using errcode = 'P0001', hint = 'IDEMPOTENCY_CONFLICT';
    end if;
    return jsonb_build_object(
      'requirement_id', v_new.id,
      'order_id', v_new.production_order_id,
      'withdrawn_requirement_id', p_requirement_id,
      'moved_quantity', (select i.quantity from public.requirement_items i where i.requirement_id = v_new.id and i.material_id = p_to_material)
        - coalesce((select i.quantity from public.requirement_items i where i.requirement_id = p_requirement_id and i.material_id = p_to_material), 0),
      'kept_quantity', coalesce((select i.quantity from public.requirement_items i where i.requirement_id = v_new.id and i.material_id = p_from_material), 0),
      'idempotent_replay', true
    );
  end if;

  -- Blokady: materiały rosnąco → wiersz listy → zlecenie.
  perform 1 from public.materials m where m.id in (p_from_material, p_to_material) order by m.id for no key update;

  select * into v_req from public.requirements r where r.id = p_requirement_id for update;
  if not found then
    raise exception 'Nie znaleziono listy' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'requirement';
  end if;
  if v_req.status = 'WITHDRAWN' then
    raise exception 'Lista została już wycofana' using errcode = 'P0001', hint = 'ALREADY_WITHDRAWN';
  end if;
  select po.status into v_status from public.production_orders po where po.id = v_req.production_order_id for share;
  if v_status not in ('OPEN', 'IN_PRODUCTION') then
    raise exception 'Zlecenie jest zakończone lub anulowane — otwórz je ponownie, aby podmienić pozycję'
      using errcode = 'P0001', hint = 'ORDER_NOT_OPEN';
  end if;

  select m.code, m.allows_fraction, m.active into v_from from public.materials m where m.id = p_from_material;
  select * into v_item from public.requirement_items i where i.requirement_id = p_requirement_id and i.material_id = p_from_material;
  if not found then
    raise exception 'Materiał nie występuje na tej liście' using errcode = 'P0001', hint = 'NOT_IN_REQUIREMENTS', detail = v_from.code;
  end if;
  if not exists (
    select 1 from public.material_substitutes s
    where s.material_a = least(p_from_material, p_to_material) and s.material_b = greatest(p_from_material, p_to_material)
  ) then
    raise exception 'Materiały nie są odpowiednikami' using errcode = 'P0001', hint = 'NOT_A_SUBSTITUTE';
  end if;
  select m.code, m.active, m.allows_fraction into v_to from public.materials m where m.id = p_to_material;
  if not found then
    raise exception 'Nie znaleziono materiału' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'material';
  end if;
  if not v_to.active then
    raise exception 'Materiał jest nieaktywny' using errcode = 'P0001', hint = 'MATERIAL_INACTIVE', detail = v_to.code;
  end if;

  -- Jeden odczyt bilansu XXX (pod blokadą XXX, PRZED wycofaniem): część pokryta wydaniem zostaje jako XXX.
  select b.needed, b.issued into v_bal
  from app.requirement_balance(array[v_req.production_order_id]) b
  where b.material_id = p_from_material;
  v_keep := least(v_item.quantity,
                  greatest(coalesce(v_bal.issued, 0) - (coalesce(v_bal.needed, v_item.quantity) - v_item.quantity), 0));
  if not v_from.allows_fraction then
    v_keep := least(v_item.quantity, ceil(v_keep));
  end if;
  -- YYY bez ułamków, XXX z ułamkami: przenoszona ilość całkowita (w dół), reszta zostaje jako XXX.
  if v_from.allows_fraction and not v_to.allows_fraction then
    v_keep := v_item.quantity - floor(v_item.quantity - v_keep);
  end if;
  v_move := v_item.quantity - v_keep;
  if v_move <= 0 then
    raise exception 'Ta pozycja jest już w całości wydana — nie ma czego podmieniać' using errcode = 'P0001', hint = 'NOTHING_TO_SUBSTITUTE';
  end if;

  -- Wycofanie — ta sama funkcja co „Wycofaj” (wiersz listy już zablokowany).
  perform public.withdraw_requirement(
    p_requirement_id,
    left('Podmiana ' || v_from.code || ' → ' || v_to.code || coalesce(' — ' || v_reason, ''), 200));

  -- Kopia: pozostałe pozycje bez zmian; XXX (część wydana); YYY (+ przeniesiona ilość).
  select jsonb_agg(x.item order by x.ord)
  into v_items
  from (
    select 1 as ord, jsonb_build_object('material_id', i.material_id, 'quantity', i.quantity, 'note', i.note,
                                        'raw_source_ref', i.raw_source_ref) as item
    from public.requirement_items i
    where i.requirement_id = p_requirement_id and i.material_id not in (p_from_material, p_to_material)
    union all
    select 2, jsonb_build_object('material_id', p_from_material, 'quantity', v_keep,
                                 'note', left(coalesce(v_item.note || '; ', '') || 'wydane przed podmianą na ' || v_to.code, 200),
                                 'raw_source_ref', v_item.raw_source_ref)
    where v_keep > 0
    union all
    select 3, jsonb_build_object('material_id', p_to_material, 'quantity', coalesce(t.quantity, 0) + v_move,
                                 'note', left(coalesce(t.note || '; ', '') || 'zamiennik za ' || v_from.code, 200),
                                 'raw_source_ref', coalesce(t.raw_source_ref, v_item.raw_source_ref))
    from (select 1) d
    left join public.requirement_items t on t.requirement_id = p_requirement_id and t.material_id = p_to_material
  ) x;

  -- Pozycje kopiowane z listy źródłowej (w tym część XXX) mogą być nieaktywne (M2a); cel YYY — aktywny (wyżej).
  select coalesce(array_agg(i.material_id), '{}') into v_keep_inactive
  from public.requirement_items i
  where i.requirement_id = p_requirement_id and i.material_id <> p_to_material;

  v_res := app.create_requirement_core(
    v_req.production_order_id, v_scope, v_req.name, v_items, p_client_request_id,
    v_req.source, v_req.imported_file_name, v_req.import_format, v_keep_inactive);

  return jsonb_build_object(
    'requirement_id', v_res ->> 'requirement_id',
    'order_id', v_req.production_order_id,
    'withdrawn_requirement_id', p_requirement_id,
    'moved_quantity', v_move,
    'kept_quantity', v_keep,
    'idempotent_replay', false
  );
end;
$$;
revoke all on function public.substitute_requirement_item(uuid, uuid, uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.substitute_requirement_item(uuid, uuid, uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. Braki zlecenia + odpowiedniki (poprzednia definicja: 20261004100000; zmiana typu wyniku → DROP)
-- ---------------------------------------------------------------------------
drop function public.order_shortages(uuid);
create function public.order_shortages(p_order_id uuid)
returns table (
  material_id uuid, material_code text, material_name text, unit text,
  needed numeric, issued numeric, remaining numeric, available numeric, shortage numeric,
  reserved numeric, free numeric, substitutes jsonb
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
    ), fr as materialized (
      select f.material_id, f.free
      from app.material_free((select coalesce(array_agg(x.material_id), '{}') from bal x)) f
    ), own as materialized (
      select r.material_id, r.quantity from public.reservations r
      where r.production_order_id = p_order_id and r.quantity > 0
    ), sb as materialized (
      select * from app.substitute_availability((select coalesce(array_agg(x.material_id), '{}') from bal x), p_order_id)
    ), st as (
      select po.status in ('OPEN', 'IN_PRODUCTION') as issuable from public.production_orders po where po.id = p_order_id
    )
    select b.material_id, m.code, m.name, m.unit, b.needed, b.issued, b.remaining,
           coalesce(f.free, 0) + coalesce(o.quantity, 0),
           case when coalesce((select s.issuable from st s), false)
                then greatest(b.remaining - coalesce(f.free, 0) - coalesce(o.quantity, 0), 0) else 0 end,
           coalesce(o.quantity, 0),
           coalesce(f.free, 0),
           coalesce(sb.substitutes, '[]'::jsonb)
    from bal b
    join public.materials m on m.id = b.material_id
    left join fr f on f.material_id = b.material_id
    left join own o on o.material_id = b.material_id
    left join sb on sb.material_id = b.material_id
    order by 9 desc, m.code;
end;
$$;
revoke all on function public.order_shortages(uuid) from public, anon, authenticated, service_role;
grant execute on function public.order_shortages(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 10. Terminal „Do wydania” + odpowiedniki (poprzednia definicja: 20261004100000; DROP — zmiana typu wyniku)
-- ---------------------------------------------------------------------------
-- substitutes[].available = wolne odpowiednika + rezerwacja TEGO zlecenia na odpowiednik (dostępne do wydania).
drop function public.order_to_issue(uuid);
create function public.order_to_issue(p_order_id uuid)
returns table (
  material_id uuid, material_code text, material_name text, unit text, allows_fraction boolean,
  remaining numeric, available numeric, reserved numeric, substitutes jsonb
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
    ), fr as materialized (
      select f.material_id, f.free
      from app.material_free((select coalesce(array_agg(x.material_id), '{}') from bal x)) f
    ), own as materialized (
      select r.material_id, r.quantity from public.reservations r
      where r.production_order_id = p_order_id and r.quantity > 0
    ), sb as materialized (
      select * from app.substitute_availability((select coalesce(array_agg(x.material_id), '{}') from bal x), p_order_id)
    )
    select b.material_id, m.code, m.name, m.unit, m.allows_fraction, b.remaining,
           coalesce(f.free, 0) + coalesce(o.quantity, 0), coalesce(o.quantity, 0),
           coalesce(sb.substitutes, '[]'::jsonb)
    from bal b
    join public.materials m on m.id = b.material_id
    left join fr f on f.material_id = b.material_id
    left join own o on o.material_id = b.material_id
    left join sb on sb.material_id = b.material_id
    order by m.code;
end;
$$;
revoke all on function public.order_to_issue(uuid) from public, anon, authenticated, service_role;
grant execute on function public.order_to_issue(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 11. Braki zbiorczo + odpowiedniki (poprzednia definicja: 20261003100000; DROP — zmiana typu wyniku)
-- ---------------------------------------------------------------------------
-- app.shortage_rows bez zmian; odpowiedniki (wolne, bez zlecenia) dokładane tylko dla zwracanej strony.
drop function public.shortages_summary(uuid, uuid, boolean);
create function public.shortages_summary(
  p_supplier_id uuid default null,
  p_category_id uuid default null,
  p_only_short boolean default true
)
returns table (
  material_id uuid, material_code text, material_name text, unit text,
  category_id uuid, category_name text, supplier_id uuid, supplier_name text,
  remaining numeric, available numeric, shortage numeric, orders jsonb, total_rows bigint, substitutes jsonb
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
    with r as materialized (
      select x.*, count(*) over () as total
      from app.shortage_rows(p_supplier_id, p_category_id, p_only_short) x
      order by x.supplier_name nulls last, x.shortage desc, x.material_code
      limit 2000
    ), sb as materialized (
      select * from app.substitute_availability((select coalesce(array_agg(y.material_id), '{}') from r y), null)
    )
    select r.material_id, r.material_code, r.material_name, r.unit, r.category_id, r.category_name, r.supplier_id,
           r.supplier_name, r.remaining, r.available, r.shortage, r.orders, r.total, coalesce(sb.substitutes, '[]'::jsonb)
    from r
    left join sb on sb.material_id = r.material_id
    order by r.supplier_name nulls last, r.shortage desc, r.material_code;
end;
$$;
revoke all on function public.shortages_summary(uuid, uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.shortages_summary(uuid, uuid, boolean) to authenticated;

-- CSV braków: nowa kolumna „Odpowiedniki na stanie” NA KOŃCU (odpowiedniki z wolnym > 0: „KOD (wolne N)”).
-- Sygnatura bez zmian (poprzednia definicja: 20261003100000).
create or replace function public.export_shortages_csv(
  p_supplier_id uuid default null,
  p_category_id uuid default null,
  p_only_short boolean default true
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c_limit constant integer := 20000;
  v_count integer;
  v_body text;
begin
  if (select app.user_role()) is distinct from 'ADMIN' and (select app.user_role()) is distinct from 'BIURO' then
    raise exception 'Brak uprawnień' using errcode = '42501';
  end if;

  with rows as materialized (
    select * from app.shortage_rows(p_supplier_id, p_category_id, p_only_short) s
    order by s.supplier_name nulls last, s.shortage desc, s.material_code
    limit c_limit + 1
  ), sb as materialized (
    select * from app.substitute_availability((select coalesce(array_agg(y.material_id), '{}') from rows y), null)
  )
  select count(*),
         string_agg(
           app.csv_text(coalesce(r.supplier_name, 'brak dostawcy')) || ';' ||
           app.csv_code(r.material_code) || ';' || app.csv_text(r.material_name) || ';' ||
           app.csv_text(r.category_name) || ';' || app.csv_text(r.unit) || ';' ||
           app.csv_num(r.remaining) || ';' || app.csv_num(r.available) || ';' || app.csv_num(r.shortage) || ';' ||
           app.csv_text((
             select string_agg(
                      coalesce((t.o ->> 'number') || ' ', '') || (t.o ->> 'name') || ' (' || app.csv_num((t.o ->> 'remaining')::numeric) || ')',
                      ', ' order by t.ord)
             from jsonb_array_elements(r.orders) with ordinality as t(o, ord)
           )) || ';' ||
           app.csv_text((
             select string_agg((u.s ->> 'code') || ' (wolne ' || app.csv_num((u.s ->> 'free')::numeric) || ')', ', ' order by u.ord)
             from jsonb_array_elements(coalesce(sb.substitutes, '[]'::jsonb)) with ordinality as u(s, ord)
             where (u.s ->> 'free')::numeric > 0
           )),
           E'\r\n' order by r.supplier_name nulls last, r.shortage desc, r.material_code)
  into v_count, v_body
  from rows r
  left join sb on sb.material_id = r.material_id;

  if v_count > c_limit then
    raise exception 'Zbyt wiele wierszy do eksportu (maks. %) — zawęź filtry', c_limit
      using errcode = 'P0001', hint = 'TOO_MANY_ROWS';
  end if;
  return 'Dostawca;Kod materiału;Nazwa materiału;Kategoria;Jednostka;Pozostało do wydania;Dostępne;Brakuje;Zlecenia;Odpowiedniki na stanie'
    || E'\r\n' || case when v_body is null then '' else v_body || E'\r\n' end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. Import: resolve_import_codes + wolne i odpowiedniki (poprzednia definicja: 20261006100000; DROP — typ wyniku)
-- ---------------------------------------------------------------------------
drop function public.resolve_import_codes(text[]);
create function public.resolve_import_codes(p_codes text[])
returns table (
  code text,
  status text,
  alias_id uuid,
  material_id uuid,
  material_code text,
  material_name text,
  unit text,
  allows_fraction boolean,
  bar_length_m numeric,
  active boolean,
  free numeric,
  substitutes jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role public.app_role := app.user_role();
begin
  if auth.uid() is null or v_role is null or v_role not in ('ADMIN', 'BIURO') then
    raise exception 'Brak uprawnień' using errcode = '42501';
  end if;
  if p_codes is null or cardinality(p_codes) > 1000 then
    raise exception 'Zbyt wiele kodów (maksymalnie 1000)' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  return query
    with input as (
      select distinct app.normalize_material_code(c) as code
      from unnest(p_codes) as c
      where c is not null and btrim(c) <> ''
    ), res as materialized (
      select i.code,
             case
               when a.action = 'IGNORE' then 'IGNORED'
               when a.action = 'MAP' then 'ALIAS_MAP'
               when m2.id is not null then 'MATERIAL'
               else 'UNKNOWN'
             end as status,
             a.id as alias_id,
             case when a.action = 'MAP' then m1.id else m2.id end as material_id
      from input i
      left join public.import_code_aliases a on a.source_code = i.code
      left join public.materials m1 on m1.id = a.material_id
      left join public.materials m2 on m2.code = i.code
    ), fr as materialized (
      select * from app.material_free((select coalesce(array_agg(distinct x.material_id), '{}') from res x))
    ), sb as materialized (
      select * from app.substitute_availability((select coalesce(array_agg(distinct x.material_id), '{}') from res x), null)
    )
    select r.code, r.status, r.alias_id, m.id, m.code, m.name, m.unit, m.allows_fraction, m.bar_length_m, m.active,
           f.free, coalesce(sb.substitutes, '[]'::jsonb)
    from res r
    left join public.materials m on m.id = r.material_id
    left join fr f on f.material_id = r.material_id
    left join sb on sb.material_id = r.material_id
    order by r.code;
end;
$$;
revoke all on function public.resolve_import_codes(text[]) from public, anon, authenticated, service_role;
grant execute on function public.resolve_import_codes(text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 13. Podsumowanie wydań na zlecenie: wiersz per (materiał, zamiennik za) (poprzednia definicja: 20261002120000)
-- ---------------------------------------------------------------------------
-- Zmiana typu wyniku → DROP. Wydanie zamiennika YYY za XXX to osobny wiersz YYY z substitute_for_* = XXX.
-- SECURITY INVOKER (RLS jak dotąd).
drop function public.order_issue_summary(uuid);
create function public.order_issue_summary(p_order_id uuid)
returns table (
  material_id uuid,
  material_code text,
  material_name text,
  unit text,
  quantity numeric,
  issues integer,
  reversals integer,
  substitute_for_id uuid,
  substitute_for_code text,
  substitute_for_name text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    m.id,
    m.code,
    m.name,
    m.unit,
    -sum(mv.quantity_delta) as quantity,
    (count(*) filter (where o.type = 'ISSUE'))::integer as issues,
    (count(*) filter (where o.type = 'REVERSAL'))::integer as reversals,
    sf.id,
    sf.code,
    sf.name
  from public.stock_movements mv
  join public.stock_operations o on o.id = mv.operation_id
  join public.materials m on m.id = mv.material_id
  left join public.materials sf on sf.id = o.substitute_for_material_id
  where o.production_order_id = p_order_id
    and o.type in ('ISSUE', 'REVERSAL')
  group by m.id, m.code, m.name, m.unit, sf.id, sf.code, sf.name
  order by m.code, sf.code nulls first
$$;
revoke all on function public.order_issue_summary(uuid) from public, anon, authenticated, service_role;
grant execute on function public.order_issue_summary(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 14. Historia ruchów: + „zamiennik za” (poprzednia definicja: 20261005100000)
-- ---------------------------------------------------------------------------
-- Zmiana minimalna: pola 'substitute_for_material_id', 'substitute_for_code', 'substitute_for_name'
-- (left join materials). Ta sama sygnatura — create or replace zachowuje uprawnienia.
create or replace function public.list_stock_movements(
  p_type text default null,
  p_material_q text default null,
  p_date_from date default null,
  p_date_to date default null,
  p_page integer default 1,
  p_page_size integer default 50,
  p_since timestamptz default null,
  p_production_order_id uuid default null,
  p_collapse_transfers boolean default false,
  p_material_id uuid default null,
  p_location_id uuid default null,
  p_user_id uuid default null,
  p_operation_id uuid default null
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
  v_collapse boolean := coalesce(p_collapse_transfers, false);
  v_total bigint;
  v_items jsonb;
begin
  if v_role is null then
    raise exception 'Brak uprawnień' using errcode = '42501';
  end if;
  v_only := case when v_role = 'PRODUKCJA' then v_uid end;
  if p_page is null or p_page < 1 or p_page > 100000 or p_page_size is null or p_page_size < 1 or p_page_size > 100 then
    raise exception 'Nieprawidłowa strona' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  if p_type is not null and p_type not in ('RECEIPT', 'ISSUE', 'TRANSFER', 'ADJUSTMENT', 'INVENTORY', 'REVERSAL') then
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

  -- Wspólny zbiór wierszy (ruch + operacja + oryginał storna); „transfer_like” = przesunięcie albo jego storno.
  with base as (
    select
      mv.id,
      mv.created_at,
      mv.quantity_delta,
      mv.material_id,
      mv.location_id,
      mv.user_id,
      o.id as op_id,
      o.type,
      (o.type = 'TRANSFER' or (o.type = 'REVERSAL' and ro.type = 'TRANSFER')) as transfer_like
    from public.stock_movements mv
    join public.stock_operations o on o.id = mv.operation_id
    left join public.stock_operations ro on ro.id = o.reverses_operation_id
    where (p_type is null or o.type = p_type)
      and (v_only is null or mv.user_id = v_only)
      and (p_user_id is null or mv.user_id = p_user_id)
      and (p_production_order_id is null or o.production_order_id = p_production_order_id)
      and (p_operation_id is null or o.id = p_operation_id or o.reverses_operation_id = p_operation_id)
      and (p_material_id is null or mv.material_id = p_material_id)
      and (v_from is null or mv.created_at >= v_from)
      and (v_to is null or mv.created_at < v_to)
  ),
  filtered as (
    select b.*
    from base b
    join public.materials m on m.id = b.material_id
    where (not v_collapse or not b.transfer_like or b.quantity_delta > 0)
      and (v_pattern is null or m.code ilike v_pattern or m.name ilike v_pattern)
      and (
        p_location_id is null
        or b.location_id = p_location_id
        or (v_collapse and b.transfer_like and exists (
          select 1 from public.stock_movements m3 where m3.operation_id = b.op_id and m3.location_id = p_location_id
        ))
      )
  ),
  counted as (
    select count(*) as total from filtered
  ),
  page as (
    select * from filtered
    order by created_at desc, id desc
    limit p_page_size offset (p_page - 1) * p_page_size
  )
  select
    (select total from counted),
    coalesce(jsonb_agg(jsonb_build_object(
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
      'reason', o.reason,
      'reason_code', o.reason_code,
      'production_order_id', o.production_order_id,
      'production_order_name', po.name,
      'from_location_code', tr.from_code,
      'to_location_code', tr.to_code,
      'reverses_operation_id', o.reverses_operation_id,
      'reverses_type', ro.type,
      'reverses_created_at', ro.created_at,
      'reversed_by_operation_id', rv.id,
      'reversed_at', rv.created_at,
      'reversed_by_user_name', rvp.full_name,
      'reversed_reason', rv.reason,
      'reversible', (o.type <> 'REVERSAL' and rv.id is null),
      'inventory_session_id', o.inventory_session_id,
      'inventory_session_name', isn.name,
      'substitute_for_material_id', o.substitute_for_material_id,
      'substitute_for_code', sf.code,
      'substitute_for_name', sf.name
    ) order by pg.created_at desc, pg.id desc), '[]'::jsonb)
  into v_total, v_items
  from page pg
  join public.stock_movements mv on mv.id = pg.id
  join public.stock_operations o on o.id = mv.operation_id
  join public.materials m on m.id = mv.material_id
  join public.locations l on l.id = mv.location_id
  join public.profiles p on p.id = mv.user_id
  left join public.suppliers sp on sp.id = o.supplier_id
  left join public.production_orders po on po.id = o.production_order_id
  left join public.stock_operations ro on ro.id = o.reverses_operation_id
  left join public.stock_operations rv on rv.reverses_operation_id = o.id
  left join public.profiles rvp on rvp.id = rv.user_id
  left join public.inventory_sessions isn on isn.id = o.inventory_session_id
  left join public.materials sf on sf.id = o.substitute_for_material_id
  left join lateral (
    select
      max(l2.code) filter (where m2.quantity_delta < 0) as from_code,
      max(l2.code) filter (where m2.quantity_delta > 0) as to_code
    from public.stock_movements m2
    join public.locations l2 on l2.id = m2.location_id
    where m2.operation_id = o.id and pg.transfer_like
  ) tr on true;

  return jsonb_build_object('total', v_total, 'items', v_items);
end;
$$;
