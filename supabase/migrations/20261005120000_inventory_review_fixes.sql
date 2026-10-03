-- Poprawki po review Etapu 13 (ADR 015, „Poprawki po review”). Migracja addytywna + zmiany dwóch funkcji inwentaryzacji.
--
-- HIGH-1: dwóch liczących na tej samej lokalizacji. inventory_session_locations.count_version (licznik zapisów
--   lokalizacji). inventory_counting_location zwraca 'location_version'; inventory_save_location_count dostaje
--   p_expected_version (wymagany) i pod blokadą wiersza lokalizacji sesji odrzuca zapis, gdy wersja się zmieniła
--   (LOCATION_COUNT_CHANGED, 409). Pozycja COUNTED z tą samą ilością i bez ruchu od znacznika nie jest nadpisywana
--   (autor, czas i znacznik zostają).
-- LOW-2: p_started_at z przyszłości > 5 s → VALIDATION (było 5 min).
--
-- Diff względem 20261005100000_inventory.sql:
--   inventory_save_location_count — DROP + CREATE (nowa sygnatura + p_expected_version integer): walidacja wersji,
--     tolerancja 5 s, odcisk idempotencji + wersja, SELECT count_version … FOR UPDATE + LOCATION_COUNT_CHANGED,
--     w CTE x pomijane niezmienione pozycje COUNTED bez ruchu, UPDATE lokalizacji + count_version = count_version + 1,
--     wynik: 'unchanged' (zamiast 'unchanged_approved') i 'location_version'. Reszta bez zmian.
--   inventory_counting_location — create or replace (ta sama sygnatura): v_sl + count_version, wynik + 'location_version'.

alter table public.inventory_session_locations
  add column count_version integer not null default 0
    constraint inventory_session_locations_count_version_valid check (count_version >= 0);
comment on column public.inventory_session_locations.count_version is
  'Liczba zapisów liczenia lokalizacji — optymistyczna kontrola wersji (dwóch liczących na tej samej lokalizacji).';

drop function public.inventory_save_location_count(uuid, uuid, uuid, jsonb, timestamptz);

create function public.inventory_save_location_count(
  p_client_request_id uuid,
  p_session_id uuid,
  p_location_id uuid,
  p_items jsonb,
  p_started_at timestamptz,
  p_expected_version integer
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
  v_version integer;
begin
  if v_uid is null or v_role is null or v_role not in ('PRODUKCJA', 'ADMIN') then
    raise exception 'Liczenie inwentaryzacji wykonuje produkcja lub administrator' using errcode = '42501';
  end if;
  if p_client_request_id is null or p_session_id is null or p_location_id is null or p_started_at is null
     or p_expected_version is null or p_expected_version < 0 then
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
  -- LOW-2: czas z przyszłości (poza tolerancją zegara 5 s) — błąd walidacji.
  if p_started_at > now() + interval '5 seconds' then
    raise exception 'Nieprawidłowy czas rozpoczęcia liczenia' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  if p_started_at < now() - interval '12 hours' then
    raise exception 'Liczenie lokalizacji trwało zbyt długo — otwórz lokalizację ponownie i policz jeszcze raz'
      using errcode = 'P0001', hint = 'COUNT_STALE';
  end if;
  v_started := least(p_started_at, now());
  v_hash := md5(concat_ws('|', 'COUNT', p_session_id::text, p_location_id::text, extract(epoch from p_started_at)::text,
    p_expected_version::text,
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
  select sl.count_version into v_version from public.inventory_session_locations sl
  where sl.session_id = p_session_id and sl.location_id = p_location_id
  for update;
  if not found then
    raise exception 'Ta lokalizacja nie należy do sesji inwentaryzacji' using errcode = 'P0001', hint = 'LOCATION_NOT_IN_SESSION';
  end if;
  -- HIGH-1: optymistyczna kontrola wersji — ktoś zapisał tę lokalizację po otwarciu ekranu liczenia (pod blokadą wiersza).
  if v_version <> p_expected_version then
    raise exception 'Ktoś zapisał tę lokalizację w międzyczasie — otwórz ją ponownie'
      using errcode = 'P0001', hint = 'LOCATION_COUNT_CHANGED', detail = v_version::text;
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

  -- Zapis/nadpisanie liczenia + znacznik stanu. Pomijamy: pozycje zatwierdzone (ta sama ilość) oraz HIGH-1 —
  -- pozycje COUNTED z tą samą ilością i bez ruchu od znacznika (np. liczenie innej osoby przeniesione bez zmiany):
  -- autor, czas i znacznik zostają. Po ruchu (RECOUNT na żywo) ten sam wynik odświeża znacznik — to ponowne liczenie.
  with x as (
    select x.material_id, x.quantity
    from jsonb_to_recordset(v_items) as x(material_id uuid, quantity numeric)
    where not exists (
      select 1 from public.inventory_counts c
      where c.session_id = p_session_id and c.location_id = p_location_id and c.material_id = x.material_id
        and (
          c.status in ('APPROVED', 'MATCHED')
          or (c.status = 'COUNTED' and c.counted_quantity = x.quantity
              and (select count(*) from public.stock_movements mv
                   where mv.material_id = c.material_id and mv.location_id = c.location_id) = c.baseline_movement_count)
        )
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
  set counted_at = now(), counted_by = v_uid, count_version = sl.count_version + 1
  where sl.session_id = p_session_id and sl.location_id = p_location_id;

  v_result := jsonb_build_object(
    'session_id', p_session_id,
    'location_id', p_location_id,
    'saved', v_saved,
    'removed', v_removed,
    'unchanged', jsonb_array_length(v_items) - v_saved,
    'location_version', v_version + 1
  );
  insert into public.inventory_requests (id, kind, session_id, user_id, request_hash, result)
  values (p_client_request_id, 'COUNT', p_session_id, v_uid, v_hash, v_result);
  perform set_config('forbud.inventory_write', '', true);

  return v_result || jsonb_build_object('idempotent_replay', false);
end;
$$;
revoke all on function public.inventory_save_location_count(uuid, uuid, uuid, jsonb, timestamptz, integer) from public, anon, authenticated, service_role;
grant execute on function public.inventory_save_location_count(uuid, uuid, uuid, jsonb, timestamptz, integer) to authenticated;

create or replace function public.inventory_counting_location(p_session_id uuid, p_location_id uuid)
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
  select sl.counted_at, sl.count_version, p.full_name as counted_by_name into v_sl
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
    'location_version', v_sl.count_version,
    'server_time', clock_timestamp(),
    'items', v_items
  );
end;
$$;
