-- Etap 11: rezerwacje materiału dla zleceń (ADR 014).
--
-- Rezerwacja jest GLOBALNA per materiał (bez lokalizacji) i per zlecenie. „Wolne” = stan materiału w AKTYWNYCH
-- lokalizacjach − suma aktywnych rezerwacji wszystkich zleceń (dolne ograniczenie 0).
--
-- Zmiany:
--  * tabele reservations (stan bieżący), reservation_events (historia, append-only), reservation_requests
--    (idempotencja reserve/release); zapis wyłącznie funkcjami (flaga forbud.reservation_write),
--  * stock_operations: override_reservations / override_reason (wydanie ADMIN-a mimo rezerwacji),
--  * stock_issue: nowa sygnatura (+ p_override_reservations, p_override_reason z wartościami domyślnymi —
--    stare wywołania działają); dostępność = wolne + własna rezerwacja; CONSUME / OVERRIDE; RESERVED_STOCK,
--  * reserve_for_order, release_reservation, auto-zwolnienie przy DONE/CANCELLED (trigger na production_orders),
--  * odczyty: material_availability, order_reservations, order_reservation_events; order_shortages /
--    order_overview / order_to_issue liczą „dostępne dla zlecenia” = wolne + własna rezerwacja; braki
--    zbiorczo bez zmian; v_material_stock / v_stock + kolumny rezerwacji; dashboard_stats + nadrezerwacje,
--  * dezaktywacja materiału z aktywną rezerwacją → HAS_RESERVATIONS,
--  * purge_test_stock(+ p_order_ids) czyści rezerwacje materiałów testowych.
--
-- Kolejność blokad (rozszerza ADR 010/011): advisory(client_request_id) → materiał(y) FOR NO KEY UPDATE (rosnąco)
-- → zlecenie FOR SHARE → lokalizacje → wiersze stock FOR UPDATE → wiersze reservations FOR UPDATE (rosnąco po
-- (production_order_id, material_id)). Wyjątek: auto-zwolnienie (trigger) trzyma wiersz zlecenia (UPDATE statusu)
-- i blokuje TYLKO wiersze rezerwacji tego zlecenia rosnąco po material_id — nie bierze blokad materiałów.

-- ---------------------------------------------------------------------------
-- 1. Tabele
-- ---------------------------------------------------------------------------
create table public.reservations (
  id uuid primary key default gen_random_uuid(),
  production_order_id uuid not null references public.production_orders (id),
  material_id uuid not null references public.materials (id),
  -- Aktualnie zarezerwowane (0 = rezerwacja zwolniona/zużyta; wiersz zostaje dla historii zdarzeń).
  quantity numeric(12, 3) not null default 0
    constraint reservations_quantity_valid check (quantity >= 0),
  -- Czas ostatniego zwiększenia (RESERVE) — kolejność LIFO przy wydaniu ADMIN-a mimo rezerwacji.
  last_reserved_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id),
  updated_at timestamptz not null default now(),
  constraint reservations_order_material_unique unique (production_order_id, material_id)
);

create index reservations_material_active_idx on public.reservations (material_id) where quantity > 0;

comment on table public.reservations is
  'Rezerwacje materiału dla zleceń (globalne per materiał, bez lokalizacji). Zmiany wyłącznie przez funkcje (reserve_for_order, release_reservation, stock_issue, auto-zwolnienie) z wpisem w reservation_events.';

create table public.reservation_requests (
  -- = client_request_id żądania reserve/release
  id uuid primary key,
  kind text not null constraint reservation_requests_kind_valid check (kind in ('RESERVE', 'RELEASE')),
  production_order_id uuid not null references public.production_orders (id),
  user_id uuid not null references public.profiles (id),
  request_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);

comment on table public.reservation_requests is
  'Idempotencja reserve_for_order / release_reservation: odcisk parametrów i wynik zwracany przy powtórzeniu żądania.';

create table public.reservation_events (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations (id),
  type text not null
    constraint reservation_events_type_valid check (type in ('RESERVE', 'RELEASE', 'CONSUME', 'OVERRIDE', 'AUTO_RELEASE')),
  quantity_delta numeric(12, 3) not null,
  quantity_after numeric(12, 3) not null constraint reservation_events_after_valid check (quantity_after >= 0),
  -- CONSUME / OVERRIDE: wydanie, które zużyło / zabrało rezerwację.
  operation_id uuid references public.stock_operations (id),
  -- RESERVE / RELEASE: żądanie (FK odroczony — wiersz żądania z wynikiem powstaje na końcu funkcji).
  request_id uuid references public.reservation_requests (id) deferrable initially deferred,
  reason text constraint reservation_events_reason_valid check (reason is null or (reason = btrim(reason) and length(reason) between 1 and 200)),
  user_id uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  constraint reservation_events_sign check ((type = 'RESERVE' and quantity_delta > 0) or (type <> 'RESERVE' and quantity_delta < 0)),
  constraint reservation_events_links check (
    case type
      when 'RESERVE' then request_id is not null and operation_id is null
      when 'RELEASE' then request_id is not null and operation_id is null
      when 'CONSUME' then operation_id is not null and request_id is null
      when 'OVERRIDE' then operation_id is not null and request_id is null and reason is not null
      else operation_id is null and request_id is null
    end
  ),
  -- Autor wymagany; wyjątek: auto-zwolnienie wywołane zmianą statusu poza sesją użytkownika (np. klucz secret).
  constraint reservation_events_user check (user_id is not null or type = 'AUTO_RELEASE')
);

create index reservation_events_reservation_idx on public.reservation_events (reservation_id, created_at);
create index reservation_events_operation_idx on public.reservation_events (operation_id) where operation_id is not null;
create index reservation_events_request_idx on public.reservation_events (request_id) where request_id is not null;

comment on table public.reservation_events is
  'Historia rezerwacji (niemutowalna): RESERVE, RELEASE (ręczne), CONSUME (wydanie na zlecenie), OVERRIDE (ADMIN wydał mimo rezerwacji), AUTO_RELEASE (zlecenie zakończone/anulowane).';

-- ---------------------------------------------------------------------------
-- 2. Ochrona zapisu: tylko funkcje (flaga transakcyjna), historia niemutowalna, sprzątanie tylko is_test
-- ---------------------------------------------------------------------------
create function app.reservation_guard_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_purge boolean := current_setting('forbud.purge_test', true) = 'on'
                     and current_setting('role', true) = 'service_role';
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'Historii rezerwacji nie usuwa się' using errcode = 'P0001', hint = 'IMMUTABLE';
  end if;

  if tg_op = 'DELETE' and v_purge then
    if tg_table_name = 'reservations' then
      if exists (select 1 from public.materials m where m.id = old.material_id and m.is_test) then
        return old;
      end if;
    elsif tg_table_name = 'reservation_events' then
      if exists (
        select 1 from public.reservations r join public.materials m on m.id = r.material_id
        where r.id = old.reservation_id and m.is_test
      ) then
        return old;
      end if;
    elsif tg_table_name = 'reservation_requests' then
      if not exists (select 1 from public.reservation_events e where e.request_id = old.id) then
        return old;
      end if;
    end if;
  end if;

  if current_setting('forbud.reservation_write', true) = 'on' then
    -- reservations: INSERT/UPDATE z funkcji; historia i żądania: wyłącznie INSERT.
    if tg_table_name = 'reservations' and tg_op in ('INSERT', 'UPDATE') then
      return new;
    end if;
    if tg_table_name <> 'reservations' and tg_op = 'INSERT' then
      return new;
    end if;
  end if;

  raise exception 'Rezerwacje zmieniają wyłącznie funkcje rezerwacji (z wpisem w historii); historia jest niemutowalna'
    using errcode = 'P0001', hint = 'IMMUTABLE';
end;
$$;
revoke all on function app.reservation_guard_write() from public, anon, authenticated, service_role;

create trigger reservations_guard_write
  before insert or update or delete on public.reservations
  for each row execute function app.reservation_guard_write();
create trigger reservations_guard_truncate
  before truncate on public.reservations
  for each statement execute function app.reservation_guard_write();
create trigger reservation_events_guard_write
  before insert or update or delete on public.reservation_events
  for each row execute function app.reservation_guard_write();
create trigger reservation_events_guard_truncate
  before truncate on public.reservation_events
  for each statement execute function app.reservation_guard_write();
create trigger reservation_requests_guard_write
  before insert or update or delete on public.reservation_requests
  for each row execute function app.reservation_guard_write();
create trigger reservation_requests_guard_truncate
  before truncate on public.reservation_requests
  for each statement execute function app.reservation_guard_write();

alter table public.reservations enable row level security;
alter table public.reservation_events enable row level security;
alter table public.reservation_requests enable row level security;

-- Role aplikacyjne i klucz secret: wyłącznie SELECT (zapis przez funkcje SECURITY DEFINER).
revoke all on table public.reservations, public.reservation_events, public.reservation_requests
  from public, anon, authenticated, service_role;
grant select on table public.reservations, public.reservation_events, public.reservation_requests to authenticated, service_role;

create policy reservations_select on public.reservations
  for select to authenticated using ((select app.user_role()) is not null);
create policy reservation_events_select on public.reservation_events
  for select to authenticated using ((select app.user_role()) is not null);
create policy reservation_requests_select on public.reservation_requests
  for select to authenticated using ((select app.user_role()) in ('ADMIN', 'BIURO'));

-- ---------------------------------------------------------------------------
-- 3. stock_operations: wydanie ADMIN-a mimo rezerwacji (flaga + powód)
-- ---------------------------------------------------------------------------
alter table public.stock_operations
  add column override_reservations boolean not null default false,
  add column override_reason text;

alter table public.stock_operations
  add constraint stock_operations_override_valid check (
    (not override_reservations and override_reason is null)
    or (override_reservations and type = 'ISSUE'
        and override_reason = btrim(override_reason) and length(override_reason) between 3 and 200)
  );

comment on column public.stock_operations.override_reservations is
  'Wydanie ADMIN-a z pominięciem rezerwacji innych zleceń (powód w override_reason; zmniejszone rezerwacje — reservation_events OVERRIDE).';

-- ---------------------------------------------------------------------------
-- 4. Pomocnicze: wolne per materiał
-- ---------------------------------------------------------------------------
-- stock_active = Σ stanu w AKTYWNYCH lokalizacjach; reserved = Σ rezerwacji wszystkich zleceń;
-- free = max(stock_active − reserved, 0). Zwraca wiersz dla każdego podanego materiału (także bez stanu).
create function app.material_free(p_material_ids uuid[])
returns table (material_id uuid, stock_active numeric, reserved numeric, free numeric)
language sql
stable
security definer
set search_path = ''
as $$
  with ids as materialized (
    select distinct x.id from unnest(p_material_ids) as x(id) where x.id is not null
  ), st as materialized (
    select s.material_id, sum(s.quantity) as q
    from public.stock s
    join public.locations l on l.id = s.location_id and l.active
    where s.material_id in (select id from ids)
    group by s.material_id
  ), rs as materialized (
    select r.material_id, sum(r.quantity) as q
    from public.reservations r
    where r.material_id in (select id from ids) and r.quantity > 0
    group by r.material_id
  )
  select i.id, coalesce(st.q, 0), coalesce(rs.q, 0), greatest(coalesce(st.q, 0) - coalesce(rs.q, 0), 0)
  from ids i
  left join st on st.material_id = i.id
  left join rs on rs.material_id = i.id
$$;
revoke all on function app.material_free(uuid[]) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Wydanie: stock_issue z rezerwacjami
-- ---------------------------------------------------------------------------
-- Zmiana względem 20261003100000 (poprzednia wersja): nowe parametry p_override_reservations /
-- p_override_reason (wartości domyślne), kontrola roli dla override, porównanie override przy replay,
-- walidacja powodu override, krok 5b (rezerwacje: RESERVED_STOCK / override LIFO), zapis kolumn override,
-- zdarzenia CONSUME / OVERRIDE, dodatkowe pola wyniku. Reszta bez zmian.
drop function public.stock_issue(uuid, uuid, uuid, numeric, uuid, text, text, text);

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
  p_override_reason text default null
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

  -- 2. Idempotencja (jak stock_receipt): advisory lock na id; ten sam użytkownik + te same parametry → replay
  -- (nawet jeśli zlecenie zostało w międzyczasie zamknięte — operacja już się odbyła).
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
       or v_op.override_reason is distinct from v_override_reason then
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

  -- 4. Blokady (ADR 010): materiał → zlecenie → wiersz stanu → wiersze rezerwacji materiału.
  -- Materiał FOR NO KEY UPDATE serializuje wszystkie operacje na materiale (przyjęcia, wydania, przesunięcia,
  -- rezerwacje). Nieaktywny materiał — dozwolony (patrz komentarz nad funkcją).
  select m.id, m.allows_fraction into v_material
  from public.materials m
  where m.id = p_material_id
  for no key update;
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

  -- 6. Zapis (flaga zapisu obejmuje historię i stan; zerowana zaraz potem). CHECK (quantity >= 0) na stock
  -- jest ostatnią barierą.
  perform set_config('forbud.stock_write', 'on', true);

  insert into public.stock_operations (type, user_id, client_request_id, production_order_id, reason_code, reason, note,
                                       override_reservations, override_reason)
  values ('ISSUE', v_uid, p_client_request_id, p_production_order_id, p_reason_code, v_reason, v_note,
          v_override, v_override_reason)
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
  -- zleceń od najnowszej (LIFO po last_reserved_at) aż do pokrycia brakującej ilości (OVERRIDE z powodem).
  if v_consume > 0 or v_take_others > 0 then
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

    perform set_config('forbud.reservation_write', '', true);
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
    'idempotent_replay', false
  );
end;
$$;

revoke all on function public.stock_issue(uuid, uuid, uuid, numeric, uuid, text, text, text, boolean, text)
  from public, anon, authenticated, service_role;
grant execute on function public.stock_issue(uuid, uuid, uuid, numeric, uuid, text, text, text, boolean, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Rezerwacja: reserve_for_order
-- ---------------------------------------------------------------------------
-- p_items NULL = automatycznie dla każdej pozycji zapotrzebowania: min(pozostało do zarezerwowania, wolne),
-- gdzie pozostało do zarezerwowania = potrzebne − wydano netto − już zarezerwowane. p_items = [{material_id,
-- quantity}] — ręcznie (każda ilość ≤ wolne i ≤ pozostało do zarezerwowania, inaczej błąd całości).
-- Tylko materiały z zapotrzebowania zlecenia OPEN / IN_PRODUCTION. BIURO, ADMIN.
create function public.reserve_for_order(
  p_client_request_id uuid,
  p_order_id uuid,
  p_items jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role public.app_role := app.user_role();
  v_hash text;
  v_req public.reservation_requests%rowtype;
  v_status text;
  v_mats uuid[];
  v_count integer;
  v_distinct integer;
  v_row record;
  v_want numeric;
  v_q numeric;
  v_res_id uuid;
  v_after numeric;
  v_reserved jsonb := '[]'::jsonb;
  v_not jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  if v_uid is null or v_role is null or v_role not in ('ADMIN', 'BIURO') then
    raise exception 'Brak uprawnień do rezerwowania materiału' using errcode = '42501';
  end if;
  if p_client_request_id is null or p_order_id is null then
    raise exception 'Brak identyfikatora żądania lub zlecenia' using errcode = 'P0001', hint = 'VALIDATION';
  end if;

  -- Walidacja struktury ręcznych pozycji (przed odciskiem). Złe rzutowanie uuid/numeric → 22P02.
  if p_items is not null then
    if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 500
       or exists (select 1 from jsonb_array_elements(p_items) e where jsonb_typeof(e) <> 'object') then
      raise exception 'Nieprawidłowa lista pozycji (1–500)' using errcode = 'P0001', hint = 'VALIDATION';
    end if;
    select count(*), count(distinct x.material_id) into v_count, v_distinct
    from jsonb_to_recordset(p_items) as x(material_id uuid, quantity numeric);
    if exists (select 1 from jsonb_to_recordset(p_items) as x(material_id uuid, quantity numeric) where x.material_id is null) then
      raise exception 'Pozycja bez materiału' using errcode = 'P0001', hint = 'VALIDATION';
    end if;
    if v_distinct < v_count then
      raise exception 'Ten sam materiał występuje więcej niż raz' using errcode = 'P0001', hint = 'DUPLICATE_MATERIAL';
    end if;
    if exists (
      select 1 from jsonb_to_recordset(p_items) as x(material_id uuid, quantity numeric)
      where x.quantity is null or x.quantity <= 0 or x.quantity > 1000000 or x.quantity <> round(x.quantity, 3)
    ) then
      raise exception 'Ilość musi być większa od zera, maksymalnie 1 000 000, do 3 miejsc po przecinku'
        using errcode = 'P0001', hint = 'INVALID_QUANTITY';
    end if;
  end if;

  -- Odcisk: zlecenie + tryb (AUTO albo posortowane pozycje material|ilość bez zer końcowych).
  select md5('RESERVE|' || p_order_id::text || '|' ||
             case when p_items is null then 'AUTO'
                  else (select string_agg(x.material_id::text || ':' || trim_scale(x.quantity)::text, ',' order by x.material_id)
                        from jsonb_to_recordset(p_items) as x(material_id uuid, quantity numeric))
             end)
  into v_hash;

  perform pg_advisory_xact_lock(hashtextextended('forbud.reservation:' || p_client_request_id::text, 0));
  select * into v_req from public.reservation_requests q where q.id = p_client_request_id;
  if found then
    if v_req.user_id <> v_uid or v_req.kind <> 'RESERVE' or v_req.request_hash <> v_hash then
      raise exception 'Ten identyfikator żądania został już użyty dla innej operacji'
        using errcode = 'P0001', hint = 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_req.result || jsonb_build_object('idempotent_replay', true);
  end if;

  if not exists (select 1 from public.production_orders po where po.id = p_order_id) then
    raise exception 'Nie znaleziono zlecenia' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'order';
  end if;

  -- Zbiór materiałów (przed blokadami): ręcznie — z pozycji; automatycznie — z list ACTIVE zlecenia.
  -- Lista dodana po tym odczycie nie jest uwzględniana (kolejne „Zarezerwuj” ją obejmie).
  if p_items is not null then
    select array_agg(x.material_id order by x.material_id) into v_mats
    from jsonb_to_recordset(p_items) as x(material_id uuid, quantity numeric);
    if exists (select 1 from unnest(v_mats) as u(id) where not exists (select 1 from public.materials m where m.id = u.id)) then
      raise exception 'Nie znaleziono materiału' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'material';
    end if;
  else
    select coalesce(array_agg(distinct i.material_id), '{}') into v_mats
    from public.requirements r
    join public.requirement_items i on i.requirement_id = r.id
    where r.production_order_id = p_order_id and r.status = 'ACTIVE';
  end if;

  -- Blokady: materiały rosnąco → zlecenie FOR SHARE (zmiana statusu czeka) → wiersze rezerwacji.
  perform 1 from public.materials m where m.id = any (v_mats) order by m.id for no key update;

  select po.status into v_status from public.production_orders po where po.id = p_order_id for share;
  if v_status not in ('OPEN', 'IN_PRODUCTION') then
    raise exception 'Zlecenie jest zakończone lub anulowane — nie można rezerwować' using errcode = 'P0001', hint = 'ORDER_NOT_OPEN';
  end if;

  perform 1 from public.reservations r
  where r.production_order_id = p_order_id and r.material_id = any (v_mats)
  order by r.material_id
  for update;

  perform set_config('forbud.reservation_write', 'on', true);

  for v_row in
    with bal as materialized (
      select b.material_id, b.needed, b.issued, b.remaining
      from app.requirement_balance(array[p_order_id]) b
      where b.material_id = any (v_mats)
    ), fr as materialized (
      select * from app.material_free(v_mats)
    )
    select u.id as material_id, m.code, m.allows_fraction,
           b.needed, coalesce(b.remaining, 0) as remaining,
           coalesce(r.quantity, 0) as own,
           greatest(coalesce(b.remaining, 0) - coalesce(r.quantity, 0), 0) as to_reserve,
           f.free,
           (select x.quantity from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as x(material_id uuid, quantity numeric)
            where x.material_id = u.id) as wanted
    from unnest(v_mats) as u(id)
    join public.materials m on m.id = u.id
    left join bal b on b.material_id = u.id
    left join public.reservations r on r.production_order_id = p_order_id and r.material_id = u.id
    left join fr f on f.material_id = u.id
    order by u.id
  loop
    if p_items is not null then
      if v_row.needed is null then
        raise exception 'Materiał % nie występuje w zapotrzebowaniu zlecenia', v_row.code
          using errcode = 'P0001', hint = 'NOT_IN_REQUIREMENTS', detail = v_row.code;
      end if;
      if not v_row.allows_fraction and v_row.wanted <> trunc(v_row.wanted) then
        raise exception 'Ten materiał liczy się w całych jednostkach' using errcode = 'P0001', hint = 'NOT_INTEGER', detail = v_row.code;
      end if;
      if v_row.wanted > v_row.to_reserve then
        raise exception 'Ilość większa niż pozostało do zarezerwowania' using errcode = 'P0001', hint = 'RESERVE_EXCEEDS_REMAINING',
          detail = jsonb_build_object('material_code', v_row.code, 'to_reserve', v_row.to_reserve, 'free', v_row.free)::text;
      end if;
      if v_row.wanted > v_row.free then
        raise exception 'Ilość większa niż wolny stan materiału' using errcode = 'P0001', hint = 'RESERVE_EXCEEDS_FREE',
          detail = jsonb_build_object('material_code', v_row.code, 'to_reserve', v_row.to_reserve, 'free', v_row.free)::text;
      end if;
      v_want := v_row.wanted;
      v_q := v_row.wanted;
    else
      v_want := v_row.to_reserve;
      v_q := least(v_row.to_reserve, v_row.free);
      if not v_row.allows_fraction then
        v_q := trunc(v_q);
      end if;
    end if;

    if v_q > 0 then
      insert into public.reservations as r (production_order_id, material_id, quantity, last_reserved_at, created_by)
      values (p_order_id, v_row.material_id, v_q, now(), v_uid)
      on conflict (production_order_id, material_id)
      do update set quantity = r.quantity + excluded.quantity, last_reserved_at = now(), updated_at = now()
      returning r.id, r.quantity into v_res_id, v_after;
      insert into public.reservation_events (reservation_id, type, quantity_delta, quantity_after, request_id, user_id)
      values (v_res_id, 'RESERVE', v_q, v_after, p_client_request_id, v_uid);
      v_reserved := v_reserved || jsonb_build_object(
        'material_id', v_row.material_id, 'material_code', v_row.code, 'quantity', v_q, 'reserved_total', v_after);
    end if;
    if v_want - v_q > 0 then
      v_not := v_not || jsonb_build_object('material_id', v_row.material_id, 'material_code', v_row.code, 'missing', v_want - v_q);
    end if;
  end loop;

  v_result := jsonb_build_object('order_id', p_order_id, 'reserved', v_reserved, 'not_reserved', v_not);
  insert into public.reservation_requests (id, kind, production_order_id, user_id, request_hash, result)
  values (p_client_request_id, 'RESERVE', p_order_id, v_uid, v_hash, v_result);

  perform set_config('forbud.reservation_write', '', true);
  return v_result || jsonb_build_object('idempotent_replay', false);
end;
$$;
revoke all on function public.reserve_for_order(uuid, uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.reserve_for_order(uuid, uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Ręczne zwolnienie: release_reservation
-- ---------------------------------------------------------------------------
-- p_material_id NULL = całe zlecenie; p_quantity NULL = cała rezerwacja materiału (ilość wymaga materiału).
-- Dozwolone przy każdym statusie zlecenia (zamknięte mają rezerwacje zwolnione automatycznie → NOTHING_TO_RELEASE).
create function public.release_reservation(
  p_client_request_id uuid,
  p_order_id uuid,
  p_material_id uuid default null,
  p_quantity numeric default null,
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
  v_hash text;
  v_req public.reservation_requests%rowtype;
  v_mats uuid[];
  v_row record;
  v_q numeric;
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
  if p_quantity is not null and p_material_id is null then
    raise exception 'Ilość podaje się tylko przy zwalnianiu jednego materiału' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  if p_quantity is not null and (p_quantity <= 0 or p_quantity > 1000000 or p_quantity <> round(p_quantity, 3)) then
    raise exception 'Ilość musi być większa od zera, maksymalnie 1 000 000, do 3 miejsc po przecinku'
      using errcode = 'P0001', hint = 'INVALID_QUANTITY';
  end if;
  if length(v_reason) > 200 then
    raise exception 'Powód do 200 znaków' using errcode = 'P0001', hint = 'VALIDATION';
  end if;

  v_hash := md5('RELEASE|' || p_order_id::text || '|' || coalesce(p_material_id::text, '*') || '|' ||
                coalesce(trim_scale(p_quantity)::text, '*') || '|' || coalesce(v_reason, ''));

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

  if p_material_id is not null then
    v_mats := array[p_material_id];
  else
    select coalesce(array_agg(r.material_id order by r.material_id), '{}') into v_mats
    from public.reservations r
    where r.production_order_id = p_order_id and r.quantity > 0;
  end if;

  -- Blokady: materiały rosnąco → wiersze rezerwacji zlecenia rosnąco po materiale.
  perform 1 from public.materials m where m.id = any (v_mats) order by m.id for no key update;
  perform 1 from public.reservations r
  where r.production_order_id = p_order_id and r.material_id = any (v_mats)
  order by r.material_id
  for update;

  perform set_config('forbud.reservation_write', 'on', true);

  for v_row in
    select r.id, r.material_id, r.quantity, m.code, m.allows_fraction
    from public.reservations r
    join public.materials m on m.id = r.material_id
    where r.production_order_id = p_order_id and r.material_id = any (v_mats) and r.quantity > 0
    order by r.material_id
  loop
    v_q := coalesce(p_quantity, v_row.quantity);
    if v_q > v_row.quantity then
      raise exception 'Nie można zwolnić więcej niż zarezerwowano' using errcode = 'P0001', hint = 'RELEASE_EXCEEDS',
        detail = v_row.quantity::text;
    end if;
    if not v_row.allows_fraction and v_q <> trunc(v_q) then
      raise exception 'Ten materiał liczy się w całych jednostkach' using errcode = 'P0001', hint = 'NOT_INTEGER', detail = v_row.code;
    end if;
    update public.reservations r
    set quantity = r.quantity - v_q, updated_at = now()
    where r.id = v_row.id
    returning r.quantity into v_after;
    insert into public.reservation_events (reservation_id, type, quantity_delta, quantity_after, request_id, reason, user_id)
    values (v_row.id, 'RELEASE', -v_q, v_after, p_client_request_id, v_reason, v_uid);
    v_released := v_released || jsonb_build_object(
      'material_id', v_row.material_id, 'material_code', v_row.code, 'quantity', v_q, 'reserved_after', v_after);
  end loop;

  if jsonb_array_length(v_released) = 0 then
    raise exception 'Brak rezerwacji do zwolnienia' using errcode = 'P0001', hint = 'NOTHING_TO_RELEASE';
  end if;

  v_result := jsonb_build_object('order_id', p_order_id, 'released', v_released);
  insert into public.reservation_requests (id, kind, production_order_id, user_id, request_hash, result)
  values (p_client_request_id, 'RELEASE', p_order_id, v_uid, v_hash, v_result);

  perform set_config('forbud.reservation_write', '', true);
  return v_result || jsonb_build_object('idempotent_replay', false);
end;
$$;
revoke all on function public.release_reservation(uuid, uuid, uuid, numeric, text) from public, anon, authenticated, service_role;
grant execute on function public.release_reservation(uuid, uuid, uuid, numeric, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Auto-zwolnienie przy DONE / CANCELLED (ta sama transakcja co zmiana statusu)
-- ---------------------------------------------------------------------------
-- Ponowne otwarcie zlecenia NIE przywraca rezerwacji. Trigger trzyma wiersz zlecenia (UPDATE) i blokuje wyłącznie
-- wiersze rezerwacji tego zlecenia rosnąco po material_id (jak release_reservation) — bez blokad materiałów.
create function app.production_orders_auto_release()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text := case new.status when 'DONE' then 'Zlecenie zakończone' else 'Zlecenie anulowane' end;
  v_row record;
  v_any boolean := false;
begin
  for v_row in
    select r.id, r.quantity from public.reservations r
    where r.production_order_id = new.id and r.quantity > 0
    order by r.material_id
    for update
  loop
    if not v_any then
      perform set_config('forbud.reservation_write', 'on', true);
      v_any := true;
    end if;
    update public.reservations r set quantity = 0, updated_at = now() where r.id = v_row.id;
    insert into public.reservation_events (reservation_id, type, quantity_delta, quantity_after, reason, user_id)
    values (v_row.id, 'AUTO_RELEASE', -v_row.quantity, 0, v_reason, auth.uid());
  end loop;
  if v_any then
    perform set_config('forbud.reservation_write', '', true);
  end if;
  return null;
end;
$$;
revoke all on function app.production_orders_auto_release() from public, anon, authenticated, service_role;

create trigger production_orders_c_auto_release
  after update of status on public.production_orders
  for each row
  when (new.status in ('DONE', 'CANCELLED') and old.status is distinct from new.status)
  execute function app.production_orders_auto_release();

-- ---------------------------------------------------------------------------
-- 9. Dezaktywacja materiału z aktywną rezerwacją → HAS_RESERVATIONS
-- ---------------------------------------------------------------------------
-- Kopia z 20261001210000 (ostatnia definicja) + kontrola rezerwacji na końcu.
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
    -- Etap 11: aktywna rezerwacja (rezerwacja bez stanu jest możliwa po korekcie/stornie w dół).
    if exists (select 1 from public.reservations r where r.material_id = old.id and r.quantity > 0) then
      raise exception 'Nie można dezaktywować materiału, który ma aktywne rezerwacje'
        using errcode = 'P0001', hint = 'HAS_RESERVATIONS';
    end if;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Odczyty: dostępność materiału, rezerwacje zlecenia, historia rezerwacji
-- ---------------------------------------------------------------------------
-- Dostępność materiału (każda aktywna rola — terminal WYDANIE, szczegóły materiału). p_order_id — zlecenie,
-- na które wydajemy (dostępne = wolne + jego rezerwacja); NULL — wydanie bez zlecenia (dostępne = wolne).
create function public.material_availability(p_material_id uuid, p_order_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_f record;
  v_own numeric;
begin
  if (select app.user_role()) is null then
    raise exception 'Brak uprawnień' using errcode = '42501';
  end if;
  select * into v_f from app.material_free(array[p_material_id]);
  select coalesce(sum(r.quantity), 0) into v_own
  from public.reservations r
  where r.material_id = p_material_id and p_order_id is not null and r.production_order_id = p_order_id;
  return jsonb_build_object(
    'material_id', p_material_id,
    'stock_active', v_f.stock_active,
    'reserved_total', v_f.reserved,
    'free', v_f.free,
    'own_reserved', v_own,
    'available_for_issue', v_f.free + v_own,
    'over_reserved', v_f.reserved > v_f.stock_active,
    'orders', coalesce((
      select jsonb_agg(jsonb_build_object('order_id', po.id, 'number', po.number, 'name', po.name, 'status', po.status,
                                          'quantity', r.quantity) order by r.quantity desc, po.name)
      from public.reservations r
      join public.production_orders po on po.id = r.production_order_id
      where r.material_id = p_material_id and r.quantity > 0), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.material_availability(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.material_availability(uuid, uuid) to authenticated;

-- Rezerwacje zlecenia (ADMIN, BIURO): pozycje zapotrzebowania + materiały z rezerwacją spoza zapotrzebowania.
-- to_reserve = max(pozostało − zarezerwowane, 0); excess = rezerwacja ponad „pozostało” (np. po wycofaniu listy).
create function public.order_reservations(p_order_id uuid)
returns table (
  material_id uuid, material_code text, material_name text, unit text, allows_fraction boolean,
  needed numeric, issued numeric, remaining numeric, reserved numeric, to_reserve numeric, excess numeric,
  stock_active numeric, reserved_total numeric, free numeric, over_reserved boolean
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
    ), own as materialized (
      select r.material_id, r.quantity from public.reservations r
      where r.production_order_id = p_order_id and r.quantity > 0
    ), mats as materialized (
      select b.material_id from bal b union select o.material_id from own o
    ), fr as materialized (
      select * from app.material_free((select coalesce(array_agg(x.material_id), '{}') from mats x))
    )
    select x.material_id, m.code, m.name, m.unit, m.allows_fraction,
           coalesce(b.needed, 0), coalesce(b.issued, 0), coalesce(b.remaining, 0),
           coalesce(o.quantity, 0),
           greatest(coalesce(b.remaining, 0) - coalesce(o.quantity, 0), 0),
           greatest(coalesce(o.quantity, 0) - coalesce(b.remaining, 0), 0),
           f.stock_active, f.reserved, f.free, f.reserved > f.stock_active
    from mats x
    join public.materials m on m.id = x.material_id
    left join bal b on b.material_id = x.material_id
    left join own o on o.material_id = x.material_id
    left join fr f on f.material_id = x.material_id
    order by m.code;
end;
$$;
revoke all on function public.order_reservations(uuid) from public, anon, authenticated, service_role;
grant execute on function public.order_reservations(uuid) to authenticated;

-- Historia rezerwacji zlecenia (ADMIN, BIURO) — nazwisko autora z profiles (SECURITY DEFINER: BIURO widzi
-- w profiles tylko siebie); najnowsze pierwsze, maks. 500.
create function public.order_reservation_events(p_order_id uuid)
returns table (
  id uuid, created_at timestamptz, type text, material_id uuid, material_code text, unit text,
  quantity_delta numeric, quantity_after numeric, reason text, operation_id uuid, user_name text,
  operation_order_id uuid, operation_order_name text
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
    select e.id, e.created_at, e.type, r.material_id, m.code, m.unit, e.quantity_delta, e.quantity_after, e.reason,
           e.operation_id, p.full_name, o.production_order_id, po.name
    from public.reservation_events e
    join public.reservations r on r.id = e.reservation_id
    join public.materials m on m.id = r.material_id
    left join public.profiles p on p.id = e.user_id
    left join public.stock_operations o on o.id = e.operation_id
    left join public.production_orders po on po.id = o.production_order_id
    where r.production_order_id = p_order_id
    order by e.created_at desc, e.id desc
    limit 500;
end;
$$;
revoke all on function public.order_reservation_events(uuid) from public, anon, authenticated, service_role;
grant execute on function public.order_reservation_events(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 11. Braki per zlecenie: dostępne dla zlecenia = wolne + własna rezerwacja (zbiorczo bez zmian)
-- ---------------------------------------------------------------------------
-- order_shortages: nowe kolumny reserved (własna rezerwacja) i free (wolne) — zmiana typu wyniku wymaga DROP.
-- Poprzednia wersja: 20261003110000.
drop function public.order_shortages(uuid);
create function public.order_shortages(p_order_id uuid)
returns table (
  material_id uuid, material_code text, material_name text, unit text,
  needed numeric, issued numeric, remaining numeric, available numeric, shortage numeric,
  reserved numeric, free numeric
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
    ), st as (
      select po.status in ('OPEN', 'IN_PRODUCTION') as issuable from public.production_orders po where po.id = p_order_id
    )
    select b.material_id, m.code, m.name, m.unit, b.needed, b.issued, b.remaining,
           coalesce(f.free, 0) + coalesce(o.quantity, 0),
           case when coalesce((select s.issuable from st s), false)
                then greatest(b.remaining - coalesce(f.free, 0) - coalesce(o.quantity, 0), 0) else 0 end,
           coalesce(o.quantity, 0),
           coalesce(f.free, 0)
    from bal b
    join public.materials m on m.id = b.material_id
    left join fr f on f.material_id = b.material_id
    left join own o on o.material_id = b.material_id
    order by 9 desc, m.code;
end;
$$;
revoke all on function public.order_shortages(uuid) from public, anon, authenticated, service_role;
grant execute on function public.order_shortages(uuid) to authenticated;

-- order_overview: flaga braków wg „dostępne dla zlecenia” (sygnatura bez zmian; poprzednio 20261003110000).
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
    ), fr as materialized (
      select f.material_id, f.free
      from app.material_free((select coalesce(array_agg(distinct x.material_id), '{}') from bal x)) f
    ), own as materialized (
      select r.production_order_id, r.material_id, r.quantity from public.reservations r
      where r.production_order_id = any (v_ids) and r.quantity > 0
    ), cnt as (
      select r.production_order_id as oid, count(*)::integer as n
      from public.requirements r
      where r.production_order_id = any (v_ids) and r.status = 'ACTIVE'
      group by r.production_order_id
    )
    select po.id,
           coalesce(c.n, 0),
           po.status in ('OPEN', 'IN_PRODUCTION')
             and coalesce(bool_or(b.remaining > coalesce(f.free, 0) + coalesce(o.quantity, 0)), false)
    from public.production_orders po
    left join cnt c on c.oid = po.id
    left join bal b on b.production_order_id = po.id
    left join fr f on f.material_id = b.material_id
    left join own o on o.production_order_id = b.production_order_id and o.material_id = b.material_id
    where po.id = any (v_ids)
    group by po.id, po.status, c.n;
end;
$$;
revoke all on function public.order_overview(uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.order_overview(uuid[]) to authenticated;

-- order_to_issue: available = dostępne DLA TEGO ZLECENIA (wolne + jego rezerwacja) + kolumna reserved.
-- Poprzednia wersja: 20261003110000 (available = stan łączny).
drop function public.order_to_issue(uuid);
create function public.order_to_issue(p_order_id uuid)
returns table (
  material_id uuid, material_code text, material_name text, unit text, allows_fraction boolean,
  remaining numeric, available numeric, reserved numeric
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
    )
    select b.material_id, m.code, m.name, m.unit, m.allows_fraction, b.remaining,
           coalesce(f.free, 0) + coalesce(o.quantity, 0), coalesce(o.quantity, 0)
    from bal b
    join public.materials m on m.id = b.material_id
    left join fr f on f.material_id = b.material_id
    left join own o on o.material_id = b.material_id
    order by m.code;
end;
$$;
revoke all on function public.order_to_issue(uuid) from public, anon, authenticated, service_role;
grant execute on function public.order_to_issue(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 12. Widoki stanów: zarezerwowane / wolne / nadrezerwacja (kolumny NA KOŃCU)
-- ---------------------------------------------------------------------------
-- Decyzja: „poniżej minimum” nadal porównuje STAN ŁĄCZNY (fizyczny sygnał do uzupełnienia magazynu);
-- „wolne” pokazujemy obok. Zapotrzebowanie zleceń (także zarezerwowane) pokazują Braki.
-- v_stock: poprzednia definicja 20261002140000.
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
  ) as below_minimum,
  -- Rezerwacje są globalne per materiał — te same wartości w każdym wierszu lokalizacji materiału.
  (select coalesce(sum(r.quantity), 0) from public.reservations r where r.material_id = s.material_id and r.quantity > 0)
    as material_reserved
from public.stock s
join public.materials m on m.id = s.material_id
join public.locations l on l.id = s.location_id;

-- v_material_stock: poprzednia definicja 20261002140000.
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
  (m.active and m.min_quantity is not null and coalesce(t.total, 0) < m.min_quantity) as below_minimum,
  case
    when m.active and m.min_quantity is not null then greatest(m.min_quantity - coalesce(t.total, 0), 0)
    else 0
  end as shortage,
  (coalesce(t.total, 0) > 0
    or (m.active and m.min_quantity is not null and coalesce(t.total, 0) < m.min_quantity)) as in_view,
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

-- create or replace view zachowuje uprawnienia; jawnie dla czytelności.
grant select on table public.v_material_stock to authenticated, service_role;
grant select on table public.v_stock to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 13. Dashboard: + materiały z rezerwacją, + nadrezerwacje (poprzednia definicja 20261002140000)
-- ---------------------------------------------------------------------------
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
    )
  );
end;
$$;

-- Materiały z nadrezerwacją (dashboard): Σ rezerwacji > stan w aktywnych lokalizacjach. ADMIN, BIURO.
create function public.over_reserved_materials()
returns table (material_id uuid, material_code text, material_name text, unit text, stock_active numeric, reserved numeric)
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
    select f.material_id, m.code, m.name, m.unit, f.stock_active, f.reserved
    from app.material_free((select coalesce(array_agg(distinct r.material_id), '{}') from public.reservations r where r.quantity > 0)) f
    join public.materials m on m.id = f.material_id
    where f.reserved > f.stock_active
    order by m.code
    limit 200;
end;
$$;
revoke all on function public.over_reserved_materials() from public, anon, authenticated, service_role;
grant execute on function public.over_reserved_materials() to authenticated;

-- ---------------------------------------------------------------------------
-- 14. Sprzątanie testów: + rezerwacje materiałów testowych, + żądania wskazanych zleceń
-- ---------------------------------------------------------------------------
-- Poprzednia definicja: 20261001210000 (zmiana sygnatury → DROP). Stare wywołania (tylko p_material_ids) działają.
drop function public.purge_test_stock(uuid[]);

create function public.purge_test_stock(p_material_ids uuid[] default null, p_order_ids uuid[] default null)
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
  -- Rezerwacje materiałów testowych (zdarzenia → rezerwacje), potem żądania wskazanych zleceń bez zdarzeń.
  delete from public.reservation_events e
  using public.reservations r
  where r.id = e.reservation_id and r.material_id = any (v_ids);
  delete from public.reservations r where r.material_id = any (v_ids);
  if p_order_ids is not null then
    if exists (
      select 1 from public.reservations r where r.production_order_id = any (p_order_ids)
    ) then
      raise exception 'Zlecenie ma rezerwacje materiałów spoza danych testowych — przerwano' using errcode = 'P0001';
    end if;
    delete from public.reservation_requests q where q.production_order_id = any (p_order_ids);
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
