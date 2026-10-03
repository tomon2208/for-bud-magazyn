-- Etap 13: inwentaryzacja (ADR 015).
--
-- Sesja inwentaryzacyjna na wybrane lokalizacje (wszystkie aktywne / prefiks kodu / zaznaczone). Liczy PRODUKCJA
-- (i ADMIN) na telefonie „na ślepo”; różnice zatwierdza BIURO lub ADMIN — operacja INVENTORY z ruchami różnic.
-- Ruchy magazynowe NIE są blokowane: przy zapisie liczenia zapisujemy znacznik stanu z chwili rozpoczęcia liczenia
-- lokalizacji (liczba ruchów i suma delt (materiał, lokalizacja) sprzed tej chwili); przy zatwierdzaniu, pod
-- blokadą materiału i wiersza stanu, inny znacznik → pozycja „do ponownego policzenia” (RECOUNT), bez różnicy.
--
-- Zmiany:
--  * tabele inventory_sessions, inventory_session_locations, inventory_counts, inventory_count_events (historia
--    liczeń, append-only), inventory_requests (idempotencja); zapis wyłącznie funkcjami (flaga
--    forbud.inventory_write); historia i żądania niemutowalne,
--  * stock_operations.inventory_session_id (FK; INVENTORY ⇔ NOT NULL),
--  * funkcje: inventory_create_session, inventory_cancel_session, inventory_close_session,
--    inventory_save_location_count, inventory_approve; odczyty: inventory_sessions_list,
--    inventory_session_overview, inventory_counting_location (liczący — bez stanów systemowych),
--    inventory_session_review i export_inventory_csv (BIURO/ADMIN — ze stanem systemowym),
--  * list_stock_movements: +inventory_session_id/name (poprzednia definicja: 20261002120000; zmiana minimalna),
--  * purge_test_stock(+ p_inventory_session_ids) — sprząta wyłącznie sesje TEST-… i liczenia materiałów is_test
--    (poprzednia definicja: 20261004110000).
--
-- Funkcji zmieniających stan (stock_receipt/issue/transfer/adjust/reverse) NIE zmieniamy. stock_reverse działa dla
-- operacji INVENTORY (wiele ruchów jednej operacji — jak przesunięcie).
--
-- Kolejność blokad (rozszerza ADR 010/011/014): advisory(client_request_id) → [inwentaryzacja: sesja] → materiał(y)
-- FOR NO KEY UPDATE (rosnąco) → zlecenie → lokalizacje FOR SHARE (rosnąco) → wiersze stock FOR UPDATE (rosnąco po
-- (material_id, location_id)) → rezerwacje. Wiersza sesji nie blokuje żadna funkcja stockowa, a funkcje
-- inwentaryzacji poza zatwierdzaniem nie blokują materiałów — brak cyklu.

-- ---------------------------------------------------------------------------
-- 1. Tabele
-- ---------------------------------------------------------------------------
create table public.inventory_sessions (
  id uuid primary key default gen_random_uuid(),
  name text not null
    constraint inventory_sessions_name_valid check (name = btrim(name) and length(name) between 1 and 120),
  note text
    constraint inventory_sessions_note_valid check (note is null or (note = btrim(note) and length(note) between 1 and 500)),
  status text not null default 'OPEN'
    constraint inventory_sessions_status_valid check (status in ('OPEN', 'CLOSED', 'CANCELLED')),
  created_at timestamptz not null default now(),
  created_by uuid not null references public.profiles (id),
  closed_at timestamptz,
  closed_by uuid references public.profiles (id),
  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles (id),
  cancel_reason text
    constraint inventory_sessions_cancel_reason_valid check (cancel_reason is null or (cancel_reason = btrim(cancel_reason) and length(cancel_reason) between 1 and 200)),
  constraint inventory_sessions_status_fields check (
    (status = 'OPEN' and closed_at is null and closed_by is null and cancelled_at is null and cancelled_by is null and cancel_reason is null)
    or (status = 'CLOSED' and closed_at is not null and closed_by is not null and cancelled_at is null and cancelled_by is null)
    or (status = 'CANCELLED' and cancelled_at is not null and cancelled_by is not null and closed_at is null and closed_by is null)
  )
);

create index inventory_sessions_status_created_idx on public.inventory_sessions (status, created_at desc);

comment on table public.inventory_sessions is
  'Sesje inwentaryzacyjne (ADR 015): OPEN (liczenie) → CLOSED albo CANCELLED. Zmiany wyłącznie funkcjami inventory_*.';

create table public.inventory_session_locations (
  session_id uuid not null references public.inventory_sessions (id),
  location_id uuid not null references public.locations (id),
  -- true dopóki sesja jest OTWARTA — unikalny indeks częściowy: lokalizacja w co najwyżej jednej otwartej sesji.
  is_open boolean not null default true,
  -- Ostatni zapis liczenia lokalizacji („policzona”).
  counted_at timestamptz,
  counted_by uuid references public.profiles (id),
  primary key (session_id, location_id),
  constraint inventory_session_locations_counted check ((counted_at is null) = (counted_by is null))
);

create unique index inventory_session_locations_one_open_idx
  on public.inventory_session_locations (location_id) where is_open;

comment on table public.inventory_session_locations is
  'Lokalizacje sesji inwentaryzacyjnej; is_open = sesja otwarta (lokalizacja w co najwyżej jednej otwartej sesji).';

create table public.inventory_counts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  location_id uuid not null,
  material_id uuid not null references public.materials (id),
  counted_quantity numeric(12, 3) not null
    constraint inventory_counts_quantity_valid check (counted_quantity >= 0 and counted_quantity <= 1000000),
  counted_by uuid not null references public.profiles (id),
  counted_at timestamptz not null,
  -- Znacznik stanu systemowego: chwila rozpoczęcia liczenia lokalizacji (czas serwera z ekranu liczenia) oraz
  -- liczba ruchów i suma delt (materiał, lokalizacja) sprzed tej chwili. Inny znacznik przy zatwierdzaniu → RECOUNT.
  count_started_at timestamptz not null,
  baseline_movement_count integer not null constraint inventory_counts_baseline_count_valid check (baseline_movement_count >= 0),
  baseline_quantity numeric(12, 3) not null,
  status text not null default 'COUNTED'
    constraint inventory_counts_status_valid check (status in ('COUNTED', 'RECOUNT', 'APPROVED', 'MATCHED')),
  operation_id uuid references public.stock_operations (id),
  approved_by uuid references public.profiles (id),
  approved_at timestamptz,
  constraint inventory_counts_location_fkey foreign key (session_id, location_id)
    references public.inventory_session_locations (session_id, location_id),
  constraint inventory_counts_unique unique (session_id, location_id, material_id),
  constraint inventory_counts_status_fields check (
    (status = 'APPROVED' and operation_id is not null and approved_by is not null and approved_at is not null)
    or (status = 'MATCHED' and operation_id is null and approved_by is not null and approved_at is not null)
    or (status in ('COUNTED', 'RECOUNT') and operation_id is null and approved_by is null and approved_at is null)
  )
);

create index inventory_counts_material_idx on public.inventory_counts (material_id);
create index inventory_counts_operation_idx on public.inventory_counts (operation_id) where operation_id is not null;

comment on table public.inventory_counts is
  'Bieżące liczenie pozycji (lokalizacja × materiał) w sesji. Edytowalne do zatwierdzenia (historia w inventory_count_events). COUNTED → APPROVED (ruch INVENTORY) / MATCHED (zgodne, bez ruchu) / RECOUNT (ruch po liczeniu).';
comment on column public.inventory_counts.baseline_movement_count is
  'Liczba ruchów (materiał, lokalizacja) utworzonych przed count_started_at — znacznik stanu z chwili liczenia.';

create table public.inventory_count_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.inventory_sessions (id),
  location_id uuid not null references public.locations (id),
  material_id uuid not null references public.materials (id),
  kind text not null
    constraint inventory_count_events_kind_valid check (kind in ('COUNT', 'REMOVE', 'RECOUNT', 'APPROVE', 'MATCH')),
  -- COUNT: nowa wartość; REMOVE: null; RECOUNT/APPROVE/MATCH: wartość liczenia w chwili zdarzenia.
  counted_quantity numeric(12, 3),
  -- COUNT/REMOVE: poprzednia wartość liczenia (null = pierwsze liczenie).
  previous_quantity numeric(12, 3),
  operation_id uuid references public.stock_operations (id),
  request_id uuid,
  user_id uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  constraint inventory_count_events_fields check (
    case kind
      when 'COUNT' then counted_quantity is not null and operation_id is null
      when 'REMOVE' then counted_quantity is null and previous_quantity is not null and operation_id is null
      when 'APPROVE' then counted_quantity is not null and operation_id is not null
      else counted_quantity is not null and operation_id is null
    end
  )
);

create index inventory_count_events_session_idx on public.inventory_count_events (session_id, created_at);
create index inventory_count_events_material_idx on public.inventory_count_events (material_id);

comment on table public.inventory_count_events is
  'Historia liczeń inwentaryzacji (niemutowalna): kto i kiedy liczył, poprzednie wartości, oznaczenia RECOUNT, zatwierdzenia.';

create table public.inventory_requests (
  -- = client_request_id
  id uuid primary key,
  kind text not null
    constraint inventory_requests_kind_valid check (kind in ('CREATE', 'COUNT', 'APPROVE', 'CLOSE', 'CANCEL')),
  session_id uuid not null references public.inventory_sessions (id),
  user_id uuid not null references public.profiles (id),
  request_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);

create index inventory_requests_session_idx on public.inventory_requests (session_id);

comment on table public.inventory_requests is
  'Idempotencja funkcji inwentaryzacji: odcisk parametrów i wynik zwracany przy powtórzeniu żądania.';

-- ---------------------------------------------------------------------------
-- 2. stock_operations: powiązanie operacji INVENTORY z sesją
-- ---------------------------------------------------------------------------
-- Przed wgraniem w bazie nie ma operacji INVENTORY (sprawdzone), więc CHECK jest spełniony.
alter table public.stock_operations
  add column inventory_session_id uuid
    constraint stock_operations_inventory_session_id_fkey references public.inventory_sessions (id);
alter table public.stock_operations
  add constraint stock_operations_inventory_link
  check ((type = 'INVENTORY') = (inventory_session_id is not null));
create index stock_operations_inventory_session_idx on public.stock_operations (inventory_session_id)
  where inventory_session_id is not null;

comment on column public.stock_operations.inventory_session_id is
  'Tylko INVENTORY: sesja inwentaryzacyjna, której różnice zatwierdzono tą operacją (user_id = zatwierdzający).';

-- ---------------------------------------------------------------------------
-- 3. Ochrona zapisu: tylko funkcje (flaga transakcyjna), historia niemutowalna, sprzątanie tylko danych testowych
-- ---------------------------------------------------------------------------
create function app.inventory_guard_write()
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
    raise exception 'Danych inwentaryzacji nie usuwa się' using errcode = 'P0001', hint = 'IMMUTABLE';
  end if;

  -- Sprzątanie testów (purge_test_stock): liczenia materiałów is_test; sesje TEST-… (z ich lokalizacjami i żądaniami).
  if tg_op = 'DELETE' and v_purge then
    if tg_table_name in ('inventory_counts', 'inventory_count_events') then
      if exists (select 1 from public.materials m where m.id = old.material_id and m.is_test) then
        return old;
      end if;
    elsif tg_table_name = 'inventory_sessions' then
      if old.name like 'TEST-%' then
        return old;
      end if;
    elsif tg_table_name in ('inventory_session_locations', 'inventory_requests') then
      if exists (select 1 from public.inventory_sessions s where s.id = old.session_id and s.name like 'TEST-%') then
        return old;
      end if;
    end if;
  end if;

  if current_setting('forbud.inventory_write', true) = 'on' then
    if tg_table_name in ('inventory_sessions', 'inventory_session_locations') and tg_op in ('INSERT', 'UPDATE') then
      return new;
    end if;
    if tg_table_name = 'inventory_counts' then
      return coalesce(new, old);
    end if;
    if tg_table_name in ('inventory_count_events', 'inventory_requests') and tg_op = 'INSERT' then
      return new;
    end if;
  end if;

  raise exception 'Dane inwentaryzacji zmieniają wyłącznie funkcje inwentaryzacji; historia liczeń jest niemutowalna'
    using errcode = 'P0001', hint = 'IMMUTABLE';
end;
$$;
revoke all on function app.inventory_guard_write() from public, anon, authenticated, service_role;

create trigger inventory_sessions_guard_write
  before insert or update or delete on public.inventory_sessions
  for each row execute function app.inventory_guard_write();
create trigger inventory_sessions_guard_truncate
  before truncate on public.inventory_sessions
  for each statement execute function app.inventory_guard_write();
create trigger inventory_session_locations_guard_write
  before insert or update or delete on public.inventory_session_locations
  for each row execute function app.inventory_guard_write();
create trigger inventory_session_locations_guard_truncate
  before truncate on public.inventory_session_locations
  for each statement execute function app.inventory_guard_write();
create trigger inventory_counts_guard_write
  before insert or update or delete on public.inventory_counts
  for each row execute function app.inventory_guard_write();
create trigger inventory_counts_guard_truncate
  before truncate on public.inventory_counts
  for each statement execute function app.inventory_guard_write();
create trigger inventory_count_events_guard_write
  before insert or update or delete on public.inventory_count_events
  for each row execute function app.inventory_guard_write();
create trigger inventory_count_events_guard_truncate
  before truncate on public.inventory_count_events
  for each statement execute function app.inventory_guard_write();
create trigger inventory_requests_guard_write
  before insert or update or delete on public.inventory_requests
  for each row execute function app.inventory_guard_write();
create trigger inventory_requests_guard_truncate
  before truncate on public.inventory_requests
  for each statement execute function app.inventory_guard_write();

alter table public.inventory_sessions enable row level security;
alter table public.inventory_session_locations enable row level security;
alter table public.inventory_counts enable row level security;
alter table public.inventory_count_events enable row level security;
alter table public.inventory_requests enable row level security;

-- Role aplikacyjne i klucz secret: wyłącznie SELECT (zapis przez funkcje SECURITY DEFINER).
revoke all on table public.inventory_sessions, public.inventory_session_locations, public.inventory_counts,
  public.inventory_count_events, public.inventory_requests
  from public, anon, authenticated, service_role;
grant select on table public.inventory_sessions, public.inventory_session_locations, public.inventory_counts,
  public.inventory_count_events, public.inventory_requests
  to authenticated, service_role;

-- Sesje i ich lokalizacje (bez danych systemowych) — każdy aktywny (liczący wybiera sesję i lokalizację).
create policy inventory_sessions_select on public.inventory_sessions
  for select to authenticated using ((select app.user_role()) is not null);
create policy inventory_session_locations_select on public.inventory_session_locations
  for select to authenticated using ((select app.user_role()) is not null);
-- Liczenia zawierają znacznik stanu systemowego (baseline_quantity) — wyłącznie ADMIN/BIURO. Liczący (PRODUKCJA)
-- czyta swoje dane przez inventory_counting_location (bez stanów systemowych).
create policy inventory_counts_select on public.inventory_counts
  for select to authenticated using ((select app.user_role()) in ('ADMIN', 'BIURO'));
create policy inventory_count_events_select on public.inventory_count_events
  for select to authenticated using ((select app.user_role()) in ('ADMIN', 'BIURO'));
create policy inventory_requests_select on public.inventory_requests
  for select to authenticated using ((select app.user_role()) in ('ADMIN', 'BIURO'));

-- ---------------------------------------------------------------------------
-- 4. Tworzenie sesji (BIURO, ADMIN)
-- ---------------------------------------------------------------------------
-- Dokładnie jeden sposób wyboru lokalizacji: zaznaczone id (aktywne), prefiks kodu (aktywne z kodem
-- zaczynającym się od prefiksu) albo wszystkie aktywne. Lokalizacja w co najwyżej jednej OTWARTEJ sesji
-- (sprawdzenie pod globalną blokadą advisory tworzenia sesji + unikalny indeks częściowy jako ostatnia bariera).
create function public.inventory_create_session(
  p_client_request_id uuid,
  p_name text,
  p_note text default null,
  p_location_ids uuid[] default null,
  p_code_prefix text default null,
  p_all_locations boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role public.app_role := app.user_role();
  v_name text := nullif(btrim(p_name), '');
  v_note text := nullif(btrim(p_note), '');
  v_prefix text := nullif(upper(btrim(p_code_prefix)), '');
  v_all boolean := coalesce(p_all_locations, false);
  v_ids uuid[];
  v_mode text;
  v_hash text;
  v_req public.inventory_requests%rowtype;
  v_locs uuid[];
  v_bad text;
  v_session_id uuid;
  v_result jsonb;
begin
  if v_uid is null or v_role is null or v_role not in ('ADMIN', 'BIURO') then
    raise exception 'Sesję inwentaryzacji tworzy biuro lub administrator' using errcode = '42501';
  end if;
  if p_client_request_id is null then
    raise exception 'Brak identyfikatora żądania' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  if v_name is null or length(v_name) > 120 then
    raise exception 'Podaj nazwę sesji (do 120 znaków)' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  if length(v_note) > 500 then
    raise exception 'Notatka do 500 znaków' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  select coalesce(array_agg(distinct x order by x), '{}') into v_ids
  from unnest(coalesce(p_location_ids, '{}'::uuid[])) as x
  where x is not null;
  if (cardinality(v_ids) > 0)::integer + (v_prefix is not null)::integer + v_all::integer <> 1 then
    raise exception 'Wybierz lokalizacje: wszystkie, prefiks kodu albo zaznaczone' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  if cardinality(v_ids) > 5000 or length(v_prefix) > 20 then
    raise exception 'Za dużo lokalizacji albo za długi prefiks' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  v_mode := case when v_all then 'ALL' when v_prefix is not null then 'PREFIX' else 'IDS' end;
  v_hash := md5(concat_ws('|', 'CREATE', v_name, coalesce(v_note, ''), v_mode, coalesce(v_prefix, ''), array_to_string(v_ids, ',')));

  -- Idempotencja
  perform pg_advisory_xact_lock(hashtextextended('forbud.inventory:' || p_client_request_id::text, 0));
  select * into v_req from public.inventory_requests r where r.id = p_client_request_id;
  if found then
    if v_req.kind <> 'CREATE' or v_req.user_id <> v_uid or v_req.request_hash <> v_hash then
      raise exception 'Ten identyfikator żądania został już użyty dla innej operacji'
        using errcode = 'P0001', hint = 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_req.result || jsonb_build_object('idempotent_replay', true);
  end if;

  -- Tworzenie sesji szeregowane: kontrola „lokalizacja w jednej otwartej sesji” widzi zatwierdzone sesje.
  perform pg_advisory_xact_lock(hashtextextended('forbud.inventory_create', 0));

  if v_mode = 'IDS' then
    if (select count(*) from public.locations l where l.id = any (v_ids)) <> cardinality(v_ids) then
      raise exception 'Nie znaleziono lokalizacji' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'location';
    end if;
    select string_agg(x.code, ', ' order by x.code) into v_bad
    from (select l.code from public.locations l where l.id = any (v_ids) and not l.active order by l.code limit 10) x;
    if v_bad is not null then
      raise exception 'Lokalizacje nieaktywne: %', v_bad using errcode = 'P0001', hint = 'LOCATION_INACTIVE', detail = v_bad;
    end if;
    v_locs := v_ids;
  elsif v_mode = 'PREFIX' then
    select coalesce(array_agg(l.id order by l.id), '{}') into v_locs
    from public.locations l
    where l.active
      and l.code like replace(replace(replace(v_prefix, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  else
    select coalesce(array_agg(l.id order by l.id), '{}') into v_locs from public.locations l where l.active;
  end if;
  if cardinality(v_locs) = 0 then
    raise exception 'Brak aktywnych lokalizacji pasujących do wyboru' using errcode = 'P0001', hint = 'NO_LOCATIONS';
  end if;

  select string_agg(x.code || ' (' || x.name || ')', ', ' order by x.code) into v_bad
  from (
    select l.code, s.name
    from public.inventory_session_locations sl
    join public.locations l on l.id = sl.location_id
    join public.inventory_sessions s on s.id = sl.session_id
    where sl.is_open and sl.location_id = any (v_locs)
    order by l.code
    limit 10
  ) x;
  if v_bad is not null then
    raise exception 'Lokalizacje są już w otwartej sesji: %', v_bad
      using errcode = 'P0001', hint = 'LOCATION_IN_OPEN_SESSION', detail = v_bad;
  end if;

  perform set_config('forbud.inventory_write', 'on', true);
  insert into public.inventory_sessions (name, note, created_by)
  values (v_name, v_note, v_uid)
  returning id into v_session_id;
  insert into public.inventory_session_locations (session_id, location_id)
  select v_session_id, x from unnest(v_locs) as x order by x;
  v_result := jsonb_build_object('session_id', v_session_id, 'name', v_name, 'location_count', cardinality(v_locs));
  insert into public.inventory_requests (id, kind, session_id, user_id, request_hash, result)
  values (p_client_request_id, 'CREATE', v_session_id, v_uid, v_hash, v_result);
  perform set_config('forbud.inventory_write', '', true);

  return v_result || jsonb_build_object('idempotent_replay', false);
end;
$$;
revoke all on function public.inventory_create_session(uuid, text, text, uuid[], text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.inventory_create_session(uuid, text, text, uuid[], text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Zamknięcie i anulowanie sesji (BIURO, ADMIN)
-- ---------------------------------------------------------------------------
-- Zamknięcie: OPEN → CLOSED; niepoliczone lokalizacje i niezatwierdzone pozycje NIE są zerowane — wynik zwraca ich
-- liczbę (UI ostrzega przed zamknięciem). Lokalizacje zwolnione (is_open = false).
create function public.inventory_close_session(p_client_request_id uuid, p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role public.app_role := app.user_role();
  v_hash text;
  v_req public.inventory_requests%rowtype;
  v_session public.inventory_sessions%rowtype;
  v_result jsonb;
begin
  if v_uid is null or v_role is null or v_role not in ('ADMIN', 'BIURO') then
    raise exception 'Sesję inwentaryzacji zamyka biuro lub administrator' using errcode = '42501';
  end if;
  if p_client_request_id is null or p_session_id is null then
    raise exception 'Brak identyfikatora żądania lub sesji' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  v_hash := md5('CLOSE|' || p_session_id::text);

  perform pg_advisory_xact_lock(hashtextextended('forbud.inventory:' || p_client_request_id::text, 0));
  select * into v_req from public.inventory_requests r where r.id = p_client_request_id;
  if found then
    if v_req.kind <> 'CLOSE' or v_req.user_id <> v_uid or v_req.request_hash <> v_hash then
      raise exception 'Ten identyfikator żądania został już użyty dla innej operacji'
        using errcode = 'P0001', hint = 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_req.result || jsonb_build_object('idempotent_replay', true);
  end if;

  select * into v_session from public.inventory_sessions s where s.id = p_session_id for no key update;
  if not found then
    raise exception 'Nie znaleziono sesji inwentaryzacji' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'session';
  end if;
  if v_session.status <> 'OPEN' then
    raise exception 'Sesja nie jest otwarta' using errcode = 'P0001', hint = 'SESSION_NOT_OPEN', detail = v_session.status;
  end if;

  v_result := jsonb_build_object(
    'session_id', p_session_id,
    'status', 'CLOSED',
    'uncounted_locations', (select count(*) from public.inventory_session_locations sl
                            where sl.session_id = p_session_id and sl.counted_at is null),
    'unapproved_counts', (select count(*) from public.inventory_counts c
                          where c.session_id = p_session_id and c.status in ('COUNTED', 'RECOUNT'))
  );

  perform set_config('forbud.inventory_write', 'on', true);
  update public.inventory_sessions s
  set status = 'CLOSED', closed_at = now(), closed_by = v_uid
  where s.id = p_session_id;
  update public.inventory_session_locations sl set is_open = false where sl.session_id = p_session_id and sl.is_open;
  insert into public.inventory_requests (id, kind, session_id, user_id, request_hash, result)
  values (p_client_request_id, 'CLOSE', p_session_id, v_uid, v_hash, v_result);
  perform set_config('forbud.inventory_write', '', true);

  return v_result || jsonb_build_object('idempotent_replay', false);
end;
$$;
revoke all on function public.inventory_close_session(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.inventory_close_session(uuid, uuid) to authenticated;

-- Anulowanie: OPEN → CANCELLED, tylko gdy żadna pozycja nie została zatwierdzona (zatwierdzone ruchy już są
-- w historii — wtedy sesję się zamyka). Liczenia zostają (historia).
create function public.inventory_cancel_session(p_client_request_id uuid, p_session_id uuid, p_reason text default null)
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
  v_req public.inventory_requests%rowtype;
  v_session public.inventory_sessions%rowtype;
  v_result jsonb;
begin
  if v_uid is null or v_role is null or v_role not in ('ADMIN', 'BIURO') then
    raise exception 'Sesję inwentaryzacji anuluje biuro lub administrator' using errcode = '42501';
  end if;
  if p_client_request_id is null or p_session_id is null then
    raise exception 'Brak identyfikatora żądania lub sesji' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  if length(v_reason) > 200 then
    raise exception 'Powód do 200 znaków' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  v_hash := md5('CANCEL|' || p_session_id::text || '|' || coalesce(v_reason, ''));

  perform pg_advisory_xact_lock(hashtextextended('forbud.inventory:' || p_client_request_id::text, 0));
  select * into v_req from public.inventory_requests r where r.id = p_client_request_id;
  if found then
    if v_req.kind <> 'CANCEL' or v_req.user_id <> v_uid or v_req.request_hash <> v_hash then
      raise exception 'Ten identyfikator żądania został już użyty dla innej operacji'
        using errcode = 'P0001', hint = 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_req.result || jsonb_build_object('idempotent_replay', true);
  end if;

  select * into v_session from public.inventory_sessions s where s.id = p_session_id for no key update;
  if not found then
    raise exception 'Nie znaleziono sesji inwentaryzacji' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'session';
  end if;
  if v_session.status <> 'OPEN' then
    raise exception 'Sesja nie jest otwarta' using errcode = 'P0001', hint = 'SESSION_NOT_OPEN', detail = v_session.status;
  end if;
  if exists (select 1 from public.inventory_counts c where c.session_id = p_session_id and c.status in ('APPROVED', 'MATCHED')) then
    raise exception 'Sesja ma zatwierdzone pozycje — zamknij ją zamiast anulować'
      using errcode = 'P0001', hint = 'SESSION_HAS_APPROVALS';
  end if;

  v_result := jsonb_build_object('session_id', p_session_id, 'status', 'CANCELLED');

  perform set_config('forbud.inventory_write', 'on', true);
  update public.inventory_sessions s
  set status = 'CANCELLED', cancelled_at = now(), cancelled_by = v_uid, cancel_reason = v_reason
  where s.id = p_session_id;
  update public.inventory_session_locations sl set is_open = false where sl.session_id = p_session_id and sl.is_open;
  insert into public.inventory_requests (id, kind, session_id, user_id, request_hash, result)
  values (p_client_request_id, 'CANCEL', p_session_id, v_uid, v_hash, v_result);
  perform set_config('forbud.inventory_write', '', true);

  return v_result || jsonb_build_object('idempotent_replay', false);
end;
$$;
revoke all on function public.inventory_cancel_session(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.inventory_cancel_session(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Zapis liczenia lokalizacji (PRODUKCJA, ADMIN) — wszystkie pozycje lokalizacji naraz
-- ---------------------------------------------------------------------------
-- p_items = pełny stan liczenia lokalizacji: [{material_id, quantity ≥ 0}] (0 = „brak na półce”). Ponowny zapis
-- nadpisuje LICZENIE (to nie jest ruch magazynowy); pozycje niezatwierdzone, których nie ma w nowej liście, są
-- usuwane (zdarzenie REMOVE). Pozycje zatwierdzone (APPROVED/MATCHED) są ostateczne: ta sama ilość → bez zmian,
-- inna → ALREADY_APPROVED. p_started_at = czas serwera z chwili otwarcia lokalizacji do liczenia (ekran liczenia):
-- znacznik stanu = liczba ruchów i suma delt sprzed tej chwili. Wynik nie zawiera stanów systemowych.
create function public.inventory_save_location_count(
  p_client_request_id uuid,
  p_session_id uuid,
  p_location_id uuid,
  p_items jsonb,
  p_started_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role public.app_role := app.user_role();
  v_items jsonb := coalesce(p_items, 'null'::jsonb);
  v_started timestamptz;
  v_hash text;
  v_req public.inventory_requests%rowtype;
  v_session public.inventory_sessions%rowtype;
  v_bad text;
  v_saved integer;
  v_removed integer;
  v_result jsonb;
begin
  if v_uid is null or v_role is null or v_role not in ('PRODUKCJA', 'ADMIN') then
    raise exception 'Liczenie inwentaryzacji wykonuje produkcja lub administrator' using errcode = '42501';
  end if;
  if p_client_request_id is null or p_session_id is null or p_location_id is null or p_started_at is null then
    raise exception 'Brak identyfikatora żądania, sesji, lokalizacji lub czasu liczenia' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  if jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) > 500 then
    raise exception 'Nieprawidłowa lista pozycji (maksymalnie 500)' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_items) e
    where jsonb_typeof(e) <> 'object'
       or jsonb_typeof(e -> 'material_id') is distinct from 'string'
       or jsonb_typeof(e -> 'quantity') is distinct from 'number'
  ) then
    raise exception 'Nieprawidłowa pozycja liczenia' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(v_items) as x(material_id uuid, quantity numeric)
    where x.quantity < 0 or x.quantity > 1000000 or x.quantity <> round(x.quantity, 3)
  ) then
    raise exception 'Ilość: od 0 do 1 000 000, do 3 miejsc po przecinku' using errcode = 'P0001', hint = 'INVALID_QUANTITY';
  end if;
  if (select count(distinct x.material_id) <> count(*) from jsonb_to_recordset(v_items) as x(material_id uuid, quantity numeric)) then
    raise exception 'Ten sam materiał występuje więcej niż raz' using errcode = 'P0001', hint = 'DUPLICATE_MATERIAL';
  end if;
  if p_started_at > now() + interval '5 minutes' then
    raise exception 'Nieprawidłowy czas rozpoczęcia liczenia' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  if p_started_at < now() - interval '12 hours' then
    raise exception 'Liczenie lokalizacji trwało zbyt długo — otwórz lokalizację ponownie i policz jeszcze raz'
      using errcode = 'P0001', hint = 'COUNT_STALE';
  end if;
  v_started := least(p_started_at, now());
  v_hash := md5(concat_ws('|', 'COUNT', p_session_id::text, p_location_id::text, extract(epoch from p_started_at)::text,
    coalesce((select string_agg(x.material_id::text || ':' || trim_scale(x.quantity)::text, ',' order by x.material_id)
              from jsonb_to_recordset(v_items) as x(material_id uuid, quantity numeric)), '')));

  -- Idempotencja
  perform pg_advisory_xact_lock(hashtextextended('forbud.inventory:' || p_client_request_id::text, 0));
  select * into v_req from public.inventory_requests r where r.id = p_client_request_id;
  if found then
    if v_req.kind <> 'COUNT' or v_req.user_id <> v_uid or v_req.request_hash <> v_hash then
      raise exception 'Ten identyfikator żądania został już użyty dla innej operacji'
        using errcode = 'P0001', hint = 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_req.result || jsonb_build_object('idempotent_replay', true);
  end if;

  -- Sesja FOR SHARE: równoległe zapisy różnych lokalizacji nie czekają na siebie; zatwierdzanie/zamknięcie
  -- (FOR NO KEY UPDATE) czeka na koniec zapisu albo zapis czeka i widzi już nowy status. Wiersz lokalizacji sesji
  -- FOR UPDATE: dwa zapisy tej samej lokalizacji jeden po drugim.
  select * into v_session from public.inventory_sessions s where s.id = p_session_id for share;
  if not found then
    raise exception 'Nie znaleziono sesji inwentaryzacji' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'session';
  end if;
  if v_session.status <> 'OPEN' then
    raise exception 'Sesja nie jest otwarta' using errcode = 'P0001', hint = 'SESSION_NOT_OPEN', detail = v_session.status;
  end if;
  perform 1 from public.inventory_session_locations sl
  where sl.session_id = p_session_id and sl.location_id = p_location_id
  for update;
  if not found then
    raise exception 'Ta lokalizacja nie należy do sesji inwentaryzacji' using errcode = 'P0001', hint = 'LOCATION_NOT_IN_SESSION';
  end if;

  -- Materiały: istnieją; ułamki wg allows_fraction.
  if exists (
    select 1 from jsonb_to_recordset(v_items) as x(material_id uuid, quantity numeric)
    where not exists (select 1 from public.materials m where m.id = x.material_id)
  ) then
    raise exception 'Nie znaleziono materiału' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'material';
  end if;
  select m.code into v_bad
  from jsonb_to_recordset(v_items) as x(material_id uuid, quantity numeric)
  join public.materials m on m.id = x.material_id
  where not m.allows_fraction and x.quantity <> trunc(x.quantity)
  order by m.code
  limit 1;
  if v_bad is not null then
    raise exception 'Materiał % liczy się w całych jednostkach', v_bad using errcode = 'P0001', hint = 'NOT_INTEGER', detail = v_bad;
  end if;
  select m.code into v_bad
  from jsonb_to_recordset(v_items) as x(material_id uuid, quantity numeric)
  join public.inventory_counts c
    on c.session_id = p_session_id and c.location_id = p_location_id and c.material_id = x.material_id
  join public.materials m on m.id = x.material_id
  where c.status in ('APPROVED', 'MATCHED') and c.counted_quantity <> x.quantity
  order by m.code
  limit 1;
  if v_bad is not null then
    raise exception 'Pozycja % jest już zatwierdzona — nie można zmienić liczenia', v_bad
      using errcode = 'P0001', hint = 'ALREADY_APPROVED', detail = v_bad;
  end if;

  perform set_config('forbud.inventory_write', 'on', true);

  -- Usunięte z listy (tylko niezatwierdzone).
  with del as (
    delete from public.inventory_counts c
    where c.session_id = p_session_id and c.location_id = p_location_id
      and c.status in ('COUNTED', 'RECOUNT')
      and not exists (
        select 1 from jsonb_to_recordset(v_items) as x(material_id uuid, quantity numeric) where x.material_id = c.material_id
      )
    returning c.material_id, c.counted_quantity
  )
  insert into public.inventory_count_events (session_id, location_id, material_id, kind, counted_quantity, previous_quantity, request_id, user_id)
  select p_session_id, p_location_id, del.material_id, 'REMOVE', null, del.counted_quantity, p_client_request_id, v_uid
  from del;
  get diagnostics v_removed = row_count;

  -- Zapis/nadpisanie liczenia + znacznik stanu (pozycje zatwierdzone pomijamy — ta sama ilość, bez zmian).
  with x as (
    select x.material_id, x.quantity
    from jsonb_to_recordset(v_items) as x(material_id uuid, quantity numeric)
    where not exists (
      select 1 from public.inventory_counts c
      where c.session_id = p_session_id and c.location_id = p_location_id and c.material_id = x.material_id
        and c.status in ('APPROVED', 'MATCHED')
    )
  ),
  prev as (
    select c.material_id, c.counted_quantity
    from public.inventory_counts c
    where c.session_id = p_session_id and c.location_id = p_location_id
  ),
  base as (
    select x.material_id, x.quantity, b.cnt, b.qty
    from x
    cross join lateral (
      select count(*)::integer as cnt, coalesce(sum(mv.quantity_delta), 0) as qty
      from public.stock_movements mv
      where mv.material_id = x.material_id and mv.location_id = p_location_id and mv.created_at < v_started
    ) b
  ),
  ups as (
    insert into public.inventory_counts as c (
      session_id, location_id, material_id, counted_quantity, counted_by, counted_at,
      count_started_at, baseline_movement_count, baseline_quantity, status
    )
    select p_session_id, p_location_id, base.material_id, base.quantity, v_uid, now(), v_started, base.cnt, base.qty, 'COUNTED'
    from base
    order by base.material_id
    on conflict (session_id, location_id, material_id) do update
    set counted_quantity = excluded.counted_quantity,
        counted_by = excluded.counted_by,
        counted_at = excluded.counted_at,
        count_started_at = excluded.count_started_at,
        baseline_movement_count = excluded.baseline_movement_count,
        baseline_quantity = excluded.baseline_quantity,
        status = 'COUNTED'
    returning c.material_id, c.counted_quantity
  )
  insert into public.inventory_count_events (session_id, location_id, material_id, kind, counted_quantity, previous_quantity, request_id, user_id)
  select p_session_id, p_location_id, ups.material_id, 'COUNT', ups.counted_quantity, prev.counted_quantity, p_client_request_id, v_uid
  from ups
  left join prev on prev.material_id = ups.material_id;
  get diagnostics v_saved = row_count;

  update public.inventory_session_locations sl
  set counted_at = now(), counted_by = v_uid
  where sl.session_id = p_session_id and sl.location_id = p_location_id;

  v_result := jsonb_build_object(
    'session_id', p_session_id,
    'location_id', p_location_id,
    'saved', v_saved,
    'removed', v_removed,
    'unchanged_approved', jsonb_array_length(v_items) - v_saved
  );
  insert into public.inventory_requests (id, kind, session_id, user_id, request_hash, result)
  values (p_client_request_id, 'COUNT', p_session_id, v_uid, v_hash, v_result);
  perform set_config('forbud.inventory_write', '', true);

  return v_result || jsonb_build_object('idempotent_replay', false);
end;
$$;
revoke all on function public.inventory_save_location_count(uuid, uuid, uuid, jsonb, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.inventory_save_location_count(uuid, uuid, uuid, jsonb, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Zatwierdzenie różnic (BIURO, ADMIN) — jedna transakcja, operacja INVENTORY
-- ---------------------------------------------------------------------------
-- p_count_ids = null → wszystkie pozycje sesji; inaczej zaznaczone. Kolejność: rola → idempotencja (advisory na id
-- jak operacje magazynowe; client_request_id = id operacji INVENTORY) → sesja FOR NO KEY UPDATE (OPEN) →
-- materiały FOR NO KEY UPDATE (rosnąco) → lokalizacje FOR SHARE (rosnąco) → wiersze stock FOR UPDATE (rosnąco) →
-- per pozycja (pod blokadami, nowy snapshot): znacznik ≠ bieżący (liczba ruchów albo stan) → RECOUNT; różnica 0 →
-- MATCHED (bez ruchu); różnica w górę dla nieaktywnego materiału/lokalizacji → pominięta (MATERIAL_INACTIVE /
-- LOCATION_INACTIVE); ułamek przy materiale całkowitym → pominięta (NOT_INTEGER); reszta → ruch INVENTORY.
-- Rezerwacje: bez zmian (ewentualna nadrezerwacja widoczna jak po korekcie).
create function public.inventory_approve(
  p_client_request_id uuid,
  p_session_id uuid,
  p_count_ids uuid[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role public.app_role := app.user_role();
  v_ids uuid[];
  v_hash text;
  v_req public.inventory_requests%rowtype;
  v_session public.inventory_sessions%rowtype;
  v_row record;
  v_cur_count bigint;
  v_cur_qty numeric;
  v_delta numeric;
  v_approve jsonb := '[]'::jsonb;
  v_recount jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_matched integer := 0;
  v_op public.stock_operations%rowtype;
  v_result jsonb;
begin
  if v_uid is null or v_role is null or v_role not in ('ADMIN', 'BIURO') then
    raise exception 'Różnice inwentaryzacji zatwierdza biuro lub administrator' using errcode = '42501';
  end if;
  if p_client_request_id is null or p_session_id is null then
    raise exception 'Brak identyfikatora żądania lub sesji' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  if p_count_ids is not null then
    select coalesce(array_agg(distinct x order by x), '{}') into v_ids from unnest(p_count_ids) as x where x is not null;
    if cardinality(v_ids) = 0 or cardinality(v_ids) > 5000 then
      raise exception 'Zaznacz pozycje do zatwierdzenia (maksymalnie 5000)' using errcode = 'P0001', hint = 'VALIDATION';
    end if;
  end if;
  v_hash := md5('APPROVE|' || p_session_id::text || '|' || coalesce(array_to_string(v_ids, ','), 'ALL'));

  -- Idempotencja: ten sam klucz advisory co operacje magazynowe (id = client_request_id operacji INVENTORY).
  perform pg_advisory_xact_lock(hashtextextended('forbud.stock_op:' || p_client_request_id::text, 0));
  select * into v_req from public.inventory_requests r where r.id = p_client_request_id;
  if found then
    if v_req.kind <> 'APPROVE' or v_req.user_id <> v_uid or v_req.request_hash <> v_hash then
      raise exception 'Ten identyfikator żądania został już użyty dla innej operacji'
        using errcode = 'P0001', hint = 'IDEMPOTENCY_CONFLICT';
    end if;
    return v_req.result || jsonb_build_object('idempotent_replay', true);
  end if;
  if exists (select 1 from public.stock_operations o where o.client_request_id = p_client_request_id) then
    raise exception 'Ten identyfikator żądania został już użyty dla innej operacji'
      using errcode = 'P0001', hint = 'IDEMPOTENCY_CONFLICT';
  end if;

  -- Sesja: szereguje zatwierdzanie z zapisem liczeń (FOR SHARE), zamknięciem i drugim zatwierdzaniem.
  select * into v_session from public.inventory_sessions s where s.id = p_session_id for no key update;
  if not found then
    raise exception 'Nie znaleziono sesji inwentaryzacji' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'session';
  end if;
  if v_session.status <> 'OPEN' then
    raise exception 'Sesja nie jest otwarta' using errcode = 'P0001', hint = 'SESSION_NOT_OPEN', detail = v_session.status;
  end if;
  if v_ids is not null and exists (
    select 1 from unnest(v_ids) as x
    where not exists (select 1 from public.inventory_counts c where c.id = x and c.session_id = p_session_id)
  ) then
    raise exception 'Nie znaleziono pozycji liczenia w tej sesji' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'count';
  end if;

  -- Blokady w stałej kolejności (ADR 010): materiały → lokalizacje → wiersze stanu.
  perform 1
  from public.materials m
  where m.id in (
    select c.material_id from public.inventory_counts c
    where c.session_id = p_session_id and c.status = 'COUNTED' and (v_ids is null or c.id = any (v_ids))
  )
  order by m.id
  for no key update;

  perform 1
  from public.locations l
  where l.id in (
    select c.location_id from public.inventory_counts c
    where c.session_id = p_session_id and c.status = 'COUNTED' and (v_ids is null or c.id = any (v_ids))
  )
  order by l.id
  for share;

  perform 1
  from public.stock s
  join public.inventory_counts c
    on c.material_id = s.material_id and c.location_id = s.location_id
  where c.session_id = p_session_id and c.status = 'COUNTED' and (v_ids is null or c.id = any (v_ids))
  order by s.material_id, s.location_id
  for update of s;

  perform set_config('forbud.inventory_write', 'on', true);

  for v_row in
    select c.id, c.material_id, c.location_id, c.counted_quantity, c.status,
           c.baseline_movement_count, c.baseline_quantity,
           m.code as material_code, m.active as material_active, m.allows_fraction,
           l.code as location_code, l.active as location_active
    from public.inventory_counts c
    join public.materials m on m.id = c.material_id
    join public.locations l on l.id = c.location_id
    where c.session_id = p_session_id and (v_ids is null or c.id = any (v_ids))
    order by c.material_id, c.location_id
  loop
    if v_row.status in ('APPROVED', 'MATCHED') then
      if v_ids is not null then
        v_skipped := v_skipped || jsonb_build_object('count_id', v_row.id, 'material_code', v_row.material_code,
          'location_code', v_row.location_code, 'reason', 'ALREADY_APPROVED');
      end if;
      continue;
    end if;
    if v_row.status = 'RECOUNT' then
      v_recount := v_recount || jsonb_build_object('count_id', v_row.id, 'material_code', v_row.material_code,
        'location_code', v_row.location_code);
      continue;
    end if;

    select count(*) into v_cur_count
    from public.stock_movements mv
    where mv.material_id = v_row.material_id and mv.location_id = v_row.location_id;
    select s.quantity into v_cur_qty
    from public.stock s
    where s.material_id = v_row.material_id and s.location_id = v_row.location_id;
    v_cur_qty := coalesce(v_cur_qty, 0);

    -- Ruch tego materiału w tej lokalizacji od rozpoczęcia liczenia → do ponownego policzenia (bez różnicy).
    if v_cur_count <> v_row.baseline_movement_count or v_cur_qty <> v_row.baseline_quantity then
      update public.inventory_counts c set status = 'RECOUNT' where c.id = v_row.id;
      insert into public.inventory_count_events (session_id, location_id, material_id, kind, counted_quantity, request_id, user_id)
      values (p_session_id, v_row.location_id, v_row.material_id, 'RECOUNT', v_row.counted_quantity, p_client_request_id, v_uid);
      v_recount := v_recount || jsonb_build_object('count_id', v_row.id, 'material_code', v_row.material_code,
        'location_code', v_row.location_code);
      continue;
    end if;

    v_delta := v_row.counted_quantity - v_cur_qty;
    if v_delta = 0 then
      update public.inventory_counts c
      set status = 'MATCHED', approved_by = v_uid, approved_at = now()
      where c.id = v_row.id;
      insert into public.inventory_count_events (session_id, location_id, material_id, kind, counted_quantity, request_id, user_id)
      values (p_session_id, v_row.location_id, v_row.material_id, 'MATCH', v_row.counted_quantity, p_client_request_id, v_uid);
      v_matched := v_matched + 1;
      continue;
    end if;
    if v_delta > 0 and not v_row.material_active then
      v_skipped := v_skipped || jsonb_build_object('count_id', v_row.id, 'material_code', v_row.material_code,
        'location_code', v_row.location_code, 'reason', 'MATERIAL_INACTIVE');
      continue;
    end if;
    if v_delta > 0 and not v_row.location_active then
      v_skipped := v_skipped || jsonb_build_object('count_id', v_row.id, 'material_code', v_row.material_code,
        'location_code', v_row.location_code, 'reason', 'LOCATION_INACTIVE');
      continue;
    end if;
    if not v_row.allows_fraction and v_row.counted_quantity <> trunc(v_row.counted_quantity) then
      v_skipped := v_skipped || jsonb_build_object('count_id', v_row.id, 'material_code', v_row.material_code,
        'location_code', v_row.location_code, 'reason', 'NOT_INTEGER');
      continue;
    end if;

    v_approve := v_approve || jsonb_build_object(
      'count_id', v_row.id,
      'material_id', v_row.material_id,
      'location_id', v_row.location_id,
      'material_code', v_row.material_code,
      'location_code', v_row.location_code,
      'previous_quantity', v_cur_qty,
      'quantity_delta', v_delta,
      'new_quantity', v_row.counted_quantity
    );
  end loop;

  if jsonb_array_length(v_approve) > 0 then
    perform set_config('forbud.stock_write', 'on', true);

    insert into public.stock_operations (type, user_id, client_request_id, inventory_session_id)
    values ('INVENTORY', v_uid, p_client_request_id, p_session_id)
    returning * into v_op;

    insert into public.stock_movements (operation_id, material_id, location_id, quantity_delta, user_id, created_at)
    select v_op.id, (a ->> 'material_id')::uuid, (a ->> 'location_id')::uuid, (a ->> 'quantity_delta')::numeric, v_uid, v_op.created_at
    from jsonb_array_elements(v_approve) as a
    order by (a ->> 'material_id')::uuid, (a ->> 'location_id')::uuid;

    -- Istniejące wiersze: UPDATE; brakujące (stan 0, różnica w górę): INSERT. Nie INSERT … ON CONFLICT — CHECK
    -- (quantity >= 0) sprawdza proponowany wiersz przed rozstrzygnięciem konfliktu (ADR 011).
    update public.stock s
    set quantity = s.quantity + x.delta, updated_at = now()
    from (
      select (a ->> 'material_id')::uuid as material_id, (a ->> 'location_id')::uuid as location_id,
             (a ->> 'quantity_delta')::numeric as delta
      from jsonb_array_elements(v_approve) as a
    ) x
    where s.material_id = x.material_id and s.location_id = x.location_id;

    insert into public.stock (material_id, location_id, quantity, updated_at)
    select x.material_id, x.location_id, x.delta, now()
    from (
      select (a ->> 'material_id')::uuid as material_id, (a ->> 'location_id')::uuid as location_id,
             (a ->> 'quantity_delta')::numeric as delta
      from jsonb_array_elements(v_approve) as a
    ) x
    where not exists (select 1 from public.stock s where s.material_id = x.material_id and s.location_id = x.location_id)
    order by x.material_id, x.location_id;

    perform set_config('forbud.stock_write', '', true);

    update public.inventory_counts c
    set status = 'APPROVED', operation_id = v_op.id, approved_by = v_uid, approved_at = now()
    where c.id in (select (a ->> 'count_id')::uuid from jsonb_array_elements(v_approve) as a);

    insert into public.inventory_count_events (session_id, location_id, material_id, kind, counted_quantity, operation_id, request_id, user_id)
    select p_session_id, (a ->> 'location_id')::uuid, (a ->> 'material_id')::uuid, 'APPROVE', (a ->> 'new_quantity')::numeric,
           v_op.id, p_client_request_id, v_uid
    from jsonb_array_elements(v_approve) as a;
  end if;

  v_result := jsonb_build_object(
    'session_id', p_session_id,
    'operation_id', v_op.id,
    'approved', v_approve,
    'approved_count', jsonb_array_length(v_approve),
    'matched_count', v_matched,
    'recount', v_recount,
    'skipped', v_skipped
  );
  insert into public.inventory_requests (id, kind, session_id, user_id, request_hash, result)
  values (p_client_request_id, 'APPROVE', p_session_id, v_uid, v_hash, v_result);
  perform set_config('forbud.inventory_write', '', true);

  return v_result || jsonb_build_object('idempotent_replay', false);
end;
$$;
revoke all on function public.inventory_approve(uuid, uuid, uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.inventory_approve(uuid, uuid, uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Odczyty bez stanów systemowych (każda aktywna rola)
-- ---------------------------------------------------------------------------
-- Lista sesji z postępem (liczba lokalizacji / policzonych). SECURITY DEFINER: nazwisko autora z profiles.
create function public.inventory_sessions_list(p_status text default null)
returns table (
  id uuid,
  name text,
  note text,
  status text,
  created_at timestamptz,
  created_by_name text,
  closed_at timestamptz,
  cancelled_at timestamptz,
  location_count integer,
  counted_location_count integer
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
  if p_status is not null and p_status not in ('OPEN', 'CLOSED', 'CANCELLED') then
    raise exception 'Nieprawidłowy status' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  return query
  select s.id, s.name, s.note, s.status, s.created_at, p.full_name, s.closed_at, s.cancelled_at,
         (select count(*) from public.inventory_session_locations sl where sl.session_id = s.id)::integer,
         (select count(*) from public.inventory_session_locations sl where sl.session_id = s.id and sl.counted_at is not null)::integer
  from public.inventory_sessions s
  join public.profiles p on p.id = s.created_by
  where p_status is null or s.status = p_status
  order by (s.status = 'OPEN') desc, s.created_at desc
  limit 200;
end;
$$;
revoke all on function public.inventory_sessions_list(text) from public, anon, authenticated, service_role;
grant execute on function public.inventory_sessions_list(text) to authenticated;

-- Szczegóły sesji: nagłówek + lokalizacje (policzona: kto/kiedy, liczba wpisanych pozycji). Bez stanów.
create function public.inventory_session_overview(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_session jsonb;
  v_locations jsonb;
begin
  if (select app.user_role()) is null then
    raise exception 'Brak uprawnień' using errcode = '42501';
  end if;
  select jsonb_build_object(
           'id', s.id, 'name', s.name, 'note', s.note, 'status', s.status,
           'created_at', s.created_at, 'created_by_name', pc.full_name,
           'closed_at', s.closed_at, 'closed_by_name', pcl.full_name,
           'cancelled_at', s.cancelled_at, 'cancelled_by_name', pca.full_name, 'cancel_reason', s.cancel_reason)
    into v_session
  from public.inventory_sessions s
  join public.profiles pc on pc.id = s.created_by
  left join public.profiles pcl on pcl.id = s.closed_by
  left join public.profiles pca on pca.id = s.cancelled_by
  where s.id = p_session_id;
  if v_session is null then
    raise exception 'Nie znaleziono sesji inwentaryzacji' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'session';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'location_id', l.id, 'code', l.code, 'name', l.name, 'active', l.active,
           'counted_at', sl.counted_at, 'counted_by_name', p.full_name,
           'item_count', (select count(*) from public.inventory_counts c
                          where c.session_id = sl.session_id and c.location_id = sl.location_id)
         ) order by l.code), '[]'::jsonb)
    into v_locations
  from public.inventory_session_locations sl
  join public.locations l on l.id = sl.location_id
  left join public.profiles p on p.id = sl.counted_by
  where sl.session_id = p_session_id;

  return jsonb_build_object('session', v_session, 'locations', v_locations);
end;
$$;
revoke all on function public.inventory_session_overview(uuid) from public, anon, authenticated, service_role;
grant execute on function public.inventory_session_overview(uuid) to authenticated;

-- Ekran liczenia lokalizacji („na ślepo”): materiały oczekiwane w lokalizacji (stan > 0) BEZ ILOŚCI, wpisane
-- liczenia (dane liczących) i stan pozycji: COUNTED / RECOUNT (ruch po liczeniu — policz ponownie) / APPROVED
-- (zatwierdzona — także zgodna, bez ujawniania, czy była różnica). server_time = znacznik rozpoczęcia liczenia.
create function public.inventory_counting_location(p_session_id uuid, p_location_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_session record;
  v_location record;
  v_sl record;
  v_items jsonb;
begin
  if (select app.user_role()) is null then
    raise exception 'Brak uprawnień' using errcode = '42501';
  end if;
  select s.id, s.name, s.status into v_session from public.inventory_sessions s where s.id = p_session_id;
  if not found then
    raise exception 'Nie znaleziono sesji inwentaryzacji' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'session';
  end if;
  select l.id, l.code, l.name, l.active into v_location from public.locations l where l.id = p_location_id;
  if not found then
    raise exception 'Nie znaleziono lokalizacji' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'location';
  end if;
  select sl.counted_at, p.full_name as counted_by_name into v_sl
  from public.inventory_session_locations sl
  left join public.profiles p on p.id = sl.counted_by
  where sl.session_id = p_session_id and sl.location_id = p_location_id;
  if not found then
    raise exception 'Ta lokalizacja nie należy do sesji inwentaryzacji' using errcode = 'P0001', hint = 'LOCATION_NOT_IN_SESSION';
  end if;

  with ids as (
    select s.material_id from public.stock s where s.location_id = p_location_id and s.quantity > 0
    union
    select c.material_id from public.inventory_counts c where c.session_id = p_session_id and c.location_id = p_location_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'material_id', m.id, 'code', m.code, 'name', m.name, 'unit', m.unit,
           'allows_fraction', m.allows_fraction, 'active', m.active,
           'expected', exists (select 1 from public.stock s where s.location_id = p_location_id and s.material_id = m.id and s.quantity > 0),
           'counted_quantity', c.counted_quantity,
           'counted_at', c.counted_at,
           'counted_by_name', p.full_name,
           'state', case
             when c.id is null then null
             when c.status in ('APPROVED', 'MATCHED') then 'APPROVED'
             when c.status = 'RECOUNT' then 'RECOUNT'
             when (select count(*) from public.stock_movements mv
                   where mv.material_id = c.material_id and mv.location_id = c.location_id) <> c.baseline_movement_count
               then 'RECOUNT'
             else 'COUNTED'
           end
         ) order by m.code), '[]'::jsonb)
    into v_items
  from ids
  join public.materials m on m.id = ids.material_id
  left join public.inventory_counts c
    on c.session_id = p_session_id and c.location_id = p_location_id and c.material_id = m.id
  left join public.profiles p on p.id = c.counted_by;

  return jsonb_build_object(
    'session', jsonb_build_object('id', v_session.id, 'name', v_session.name, 'status', v_session.status),
    'location', jsonb_build_object('id', v_location.id, 'code', v_location.code, 'name', v_location.name, 'active', v_location.active),
    'counted_at', v_sl.counted_at,
    'counted_by_name', v_sl.counted_by_name,
    'server_time', clock_timestamp(),
    'items', v_items
  );
end;
$$;
revoke all on function public.inventory_counting_location(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.inventory_counting_location(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. Odczyty ze stanem systemowym (BIURO, ADMIN)
-- ---------------------------------------------------------------------------
-- Wiersze tabeli zatwierdzania: liczenia sesji + materiały oczekiwane (stan > 0) w POLICZONYCH lokalizacjach, których
-- liczący nie wpisał (UNCOUNTED — nie zerujemy automatycznie). Status: OK (zgodne), DIFF (różnica), RECOUNT (ruch po
-- liczeniu — także wykryty na żywo), APPROVED, MATCHED, UNCOUNTED. blocked_reason dla różnicy, której nie da się
-- zatwierdzić. difference: dla APPROVED — wprowadzona delta; dla pozostałych — policzono − stan teraz.
create function app.inventory_review_rows(p_session_id uuid)
returns table (
  count_id uuid,
  location_id uuid,
  location_code text,
  location_name text,
  location_active boolean,
  material_id uuid,
  material_code text,
  material_name text,
  unit text,
  allows_fraction boolean,
  material_active boolean,
  system_quantity numeric,
  counted_quantity numeric,
  difference numeric,
  status text,
  blocked_reason text,
  counted_by_name text,
  counted_at timestamptz,
  approved_by_name text,
  approved_at timestamptz,
  operation_id uuid,
  operation_reversed boolean,
  material_stock_active numeric,
  material_reserved numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  with cnt as materialized (
    select c.*,
           (select count(*) from public.stock_movements mv
            where mv.material_id = c.material_id and mv.location_id = c.location_id) as cur_count,
           coalesce((select s.quantity from public.stock s
                     where s.material_id = c.material_id and s.location_id = c.location_id), 0) as cur_qty
    from public.inventory_counts c
    where c.session_id = p_session_id
  ),
  r as materialized (
    select c.id as count_id, c.location_id, c.material_id, c.cur_qty as system_quantity, c.counted_quantity,
           case
             when c.status = 'APPROVED' then (
               select sum(mv.quantity_delta) from public.stock_movements mv
               where mv.operation_id = c.operation_id and mv.material_id = c.material_id and mv.location_id = c.location_id)
             when c.status = 'MATCHED' then 0
             else c.counted_quantity - c.cur_qty
           end as difference,
           case
             when c.status in ('APPROVED', 'MATCHED', 'RECOUNT') then c.status
             when c.cur_count <> c.baseline_movement_count or c.cur_qty <> c.baseline_quantity then 'RECOUNT'
             when c.counted_quantity = c.cur_qty then 'OK'
             else 'DIFF'
           end as status,
           c.counted_by, c.counted_at, c.approved_by, c.approved_at, c.operation_id
    from cnt c
    union all
    select null, s.location_id, s.material_id, s.quantity, null, null, 'UNCOUNTED',
           null, null, null, null, null
    from public.stock s
    join public.inventory_session_locations sl
      on sl.session_id = p_session_id and sl.location_id = s.location_id and sl.counted_at is not null
    where s.quantity > 0
      and not exists (
        select 1 from public.inventory_counts c
        where c.session_id = p_session_id and c.location_id = s.location_id and c.material_id = s.material_id
      )
  )
  select r.count_id, r.location_id, l.code, l.name, l.active,
         r.material_id, m.code, m.name, m.unit, m.allows_fraction, m.active,
         r.system_quantity, r.counted_quantity, r.difference, r.status,
         case
           when r.status = 'DIFF' and r.difference > 0 and not m.active then 'MATERIAL_INACTIVE'
           when r.status = 'DIFF' and r.difference > 0 and not l.active then 'LOCATION_INACTIVE'
           when r.status = 'DIFF' and not m.allows_fraction and r.counted_quantity <> trunc(r.counted_quantity) then 'NOT_INTEGER'
         end,
         pc.full_name, r.counted_at, pa.full_name, r.approved_at, r.operation_id,
         (r.operation_id is not null
          and exists (select 1 from public.stock_operations o where o.reverses_operation_id = r.operation_id)),
         coalesce(mf.stock_active, 0), coalesce(mf.reserved, 0)
  from r
  join public.locations l on l.id = r.location_id
  join public.materials m on m.id = r.material_id
  left join public.profiles pc on pc.id = r.counted_by
  left join public.profiles pa on pa.id = r.approved_by
  left join app.material_free((select array_agg(distinct r2.material_id) from r r2)) mf on mf.material_id = r.material_id
  order by l.code, m.code
$$;
revoke all on function app.inventory_review_rows(uuid) from public, anon, authenticated, service_role;

create function public.inventory_session_review(p_session_id uuid)
returns table (
  count_id uuid,
  location_id uuid,
  location_code text,
  location_name text,
  location_active boolean,
  material_id uuid,
  material_code text,
  material_name text,
  unit text,
  allows_fraction boolean,
  material_active boolean,
  system_quantity numeric,
  counted_quantity numeric,
  difference numeric,
  status text,
  blocked_reason text,
  counted_by_name text,
  counted_at timestamptz,
  approved_by_name text,
  approved_at timestamptz,
  operation_id uuid,
  operation_reversed boolean,
  material_stock_active numeric,
  material_reserved numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select app.user_role()) is null or (select app.user_role()) not in ('ADMIN', 'BIURO') then
    raise exception 'Brak uprawnień' using errcode = '42501';
  end if;
  if not exists (select 1 from public.inventory_sessions s where s.id = p_session_id) then
    raise exception 'Nie znaleziono sesji inwentaryzacji' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'session';
  end if;
  return query select * from app.inventory_review_rows(p_session_id);
end;
$$;
revoke all on function public.inventory_session_review(uuid) from public, anon, authenticated, service_role;
grant execute on function public.inventory_session_review(uuid) to authenticated;

-- Historia liczeń sesji (kto, kiedy, poprzednie wartości, oznaczenia RECOUNT, zatwierdzenia) — nazwiska z profiles
-- (BIURO widzi w profiles tylko siebie, stąd SECURITY DEFINER). Najnowsze pierwsze, maks. 1000.
create function public.inventory_session_events(p_session_id uuid)
returns table (
  id uuid,
  created_at timestamptz,
  kind text,
  location_code text,
  material_code text,
  unit text,
  counted_quantity numeric,
  previous_quantity numeric,
  operation_id uuid,
  user_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select app.user_role()) is null or (select app.user_role()) not in ('ADMIN', 'BIURO') then
    raise exception 'Brak uprawnień' using errcode = '42501';
  end if;
  return query
  select e.id, e.created_at, e.kind, l.code, m.code, m.unit, e.counted_quantity, e.previous_quantity, e.operation_id, p.full_name
  from public.inventory_count_events e
  join public.locations l on l.id = e.location_id
  join public.materials m on m.id = e.material_id
  join public.profiles p on p.id = e.user_id
  where e.session_id = p_session_id
  order by e.created_at desc, l.code, m.code
  limit 1000;
end;
$$;
revoke all on function public.inventory_session_events(uuid) from public, anon, authenticated, service_role;
grant execute on function public.inventory_session_events(uuid) to authenticated;

-- CSV różnic (jak inne eksporty: tekst z bazy, BOM dokleja route handler). p_only_diff — tylko pozycje z różnicą,
-- do ponownego policzenia, niepoliczone i zatwierdzone różnice.
create function public.export_inventory_csv(p_session_id uuid, p_only_diff boolean default false)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_body text;
begin
  if (select app.user_role()) is null or (select app.user_role()) not in ('ADMIN', 'BIURO') then
    raise exception 'Brak uprawnień' using errcode = '42501';
  end if;
  if not exists (select 1 from public.inventory_sessions s where s.id = p_session_id) then
    raise exception 'Nie znaleziono sesji inwentaryzacji' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'session';
  end if;

  select string_agg(
           app.csv_code(r.location_code) || ';' || app.csv_code(r.material_code) || ';' || app.csv_text(r.material_name) || ';' ||
           app.csv_text(r.unit) || ';' || app.csv_num(r.system_quantity) || ';' || app.csv_num(r.counted_quantity) || ';' ||
           app.csv_num(r.difference) || ';' ||
           app.csv_text(case r.status
             when 'OK' then 'zgodne'
             when 'DIFF' then 'różnica' || case when r.blocked_reason is not null then ' (nie do zatwierdzenia)' else '' end
             when 'RECOUNT' then 'do ponownego policzenia'
             when 'APPROVED' then 'zatwierdzona różnica' || case when r.operation_reversed then ' (cofnięta)' else '' end
             when 'MATCHED' then 'zgodne (zatwierdzone)'
             when 'UNCOUNTED' then 'niepoliczona'
             else r.status end) || ';' ||
           app.csv_text(r.counted_by_name) || ';' ||
           coalesce(to_char(r.counted_at at time zone 'Europe/Warsaw', 'YYYY-MM-DD HH24:MI'), ''),
           E'\r\n' order by r.location_code, r.material_code)
    into v_body
  from app.inventory_review_rows(p_session_id) r
  where not coalesce(p_only_diff, false)
     or r.status in ('DIFF', 'RECOUNT', 'UNCOUNTED')
     or (r.status = 'APPROVED' and coalesce(r.difference, 0) <> 0);

  return 'Lokalizacja;Kod materiału;Nazwa materiału;Jednostka;Stan systemowy;Policzono;Różnica;Status;Liczył;Data liczenia'
         || E'\r\n' || coalesce(v_body || E'\r\n', '');
end;
$$;
revoke all on function public.export_inventory_csv(uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.export_inventory_csv(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 10. Historia ruchów: list_stock_movements + sesja inwentaryzacji (poprzednia definicja: 20261002120000)
-- ---------------------------------------------------------------------------
-- Zmiana minimalna: pola 'inventory_session_id', 'inventory_session_name' (left join inventory_sessions). Reszta
-- bez zmian (ta sama sygnatura — create or replace zachowuje uprawnienia).
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
      'inventory_session_name', isn.name
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

-- ---------------------------------------------------------------------------
-- 11. Sprzątanie testów: purge_test_stock + sesje inwentaryzacji (poprzednia definicja: 20261004110000)
-- ---------------------------------------------------------------------------
-- Zmiana: nowy parametr p_inventory_session_ids (sesje o nazwie TEST-… — inne id pomijane); liczenia i historia
-- liczeń materiałów is_test usuwane przed operacjami (FK operation_id); sesja z liczeniami materiałów spoza danych
-- testowych przerywa całość. Reszta bez zmian. Nowa sygnatura (DROP + CREATE) — wywołania nazwanymi
-- parametrami (p_material_ids, p_order_ids) działają jak dotąd.
drop function public.purge_test_stock(uuid[], uuid[]);

create function public.purge_test_stock(
  p_material_ids uuid[] default null,
  p_order_ids uuid[] default null,
  p_inventory_session_ids uuid[] default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_ops uuid[];
  v_orders uuid[];
  v_sessions uuid[];
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

  -- Sesje inwentaryzacji: tylko o nazwie TEST-… (jak zlecenia).
  select coalesce(array_agg(s.id), '{}') into v_sessions
  from public.inventory_sessions s
  where s.id = any (coalesce(p_inventory_session_ids, '{}')) and s.name like 'TEST-%';

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

  -- Inwentaryzacja: liczenia i ich historia materiałów testowych (przed operacjami — FK operation_id).
  delete from public.inventory_count_events e where e.material_id = any (v_ids);
  delete from public.inventory_counts c where c.material_id = any (v_ids);
  if cardinality(v_sessions) > 0 then
    if exists (select 1 from public.inventory_counts c where c.session_id = any (v_sessions))
       or exists (select 1 from public.inventory_count_events e where e.session_id = any (v_sessions))
       or exists (select 1 from public.stock_operations o
                  where o.inventory_session_id = any (v_sessions) and not (o.id = any (v_ops))) then
      raise exception 'Sesja inwentaryzacji ma liczenia materiałów spoza danych testowych — przerwano' using errcode = 'P0001';
    end if;
  end if;

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

  if cardinality(v_sessions) > 0 then
    delete from public.inventory_requests q where q.session_id = any (v_sessions);
    delete from public.inventory_session_locations sl where sl.session_id = any (v_sessions);
    delete from public.inventory_sessions s where s.id = any (v_sessions);
  end if;

  perform set_config('forbud.purge_test', '', true);
  return v_deleted;
end;
$$;
revoke all on function public.purge_test_stock(uuid[], uuid[], uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.purge_test_stock(uuid[], uuid[], uuid[]) to service_role;
