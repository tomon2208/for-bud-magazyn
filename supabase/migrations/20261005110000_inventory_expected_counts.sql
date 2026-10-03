-- Etap 13 — poprawka przed review (ADR 015, „Ograniczenia” → rozwiązane): inventory_approve z ilościami, które widział
-- zatwierdzający (p_expected_counts {"<count_id>": ilość}). Pozycja, której liczenie zmieniono po wczytaniu tabeli,
-- jest pomijana z powodem COUNT_CHANGED zamiast zatwierdzać wartość, której zatwierdzający nie widział.
-- Poprzednia definicja: 20261005100000_inventory.sql. Zmiany: nowy parametr (wartość domyślna — stare wywołania
-- działają), walidacja, odcisk idempotencji obejmuje oczekiwane ilości, kontrola COUNT_CHANGED w pętli. Reszta bez zmian.

drop function public.inventory_approve(uuid, uuid, uuid[]);

create function public.inventory_approve(
  p_client_request_id uuid,
  p_session_id uuid,
  p_count_ids uuid[] default null,
  p_expected_counts jsonb default null
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
  v_expected text;
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
  -- Ilości policzone, które widział zatwierdzający: {"<count_id>": ilość}. Inna wartość w bazie (liczenie zmieniono
  -- po wczytaniu tabeli) → pozycja pominięta z powodem COUNT_CHANGED (analogia do STOCK_CHANGED z ADR 011).
  if p_expected_counts is not null and (
    jsonb_typeof(p_expected_counts) <> 'object'
    or exists (select 1 from jsonb_each(p_expected_counts) e where jsonb_typeof(e.value) <> 'number')
  ) then
    raise exception 'Nieprawidłowe ilości oczekiwane' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  v_expected := coalesce((select string_agg(e.key || ':' || trim_scale((e.value #>> '{}')::numeric)::text, ',' order by e.key)
                          from jsonb_each(p_expected_counts) e), '');
  v_hash := md5('APPROVE|' || p_session_id::text || '|' || coalesce(array_to_string(v_ids, ','), 'ALL') || '|' || v_expected);

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
    if p_expected_counts ? v_row.id::text
       and (p_expected_counts ->> v_row.id::text)::numeric <> v_row.counted_quantity then
      v_skipped := v_skipped || jsonb_build_object('count_id', v_row.id, 'material_code', v_row.material_code,
        'location_code', v_row.location_code, 'reason', 'COUNT_CHANGED');
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
revoke all on function public.inventory_approve(uuid, uuid, uuid[], jsonb) from public, anon, authenticated, service_role;
grant execute on function public.inventory_approve(uuid, uuid, uuid[], jsonb) to authenticated;
