-- Poprawki po review Etapu 6 (ADR 011, „Poprawki po review”). Migracja addytywna.
-- L1: stock_operations.adjust_expected — stan widziany przez ADMIN-a przy korekcie (zapisywany, porównywany przy replayu
--     osobno od różnicy: ten sam id z (5, 0) i (105, 100) → IDEMPOTENCY_CONFLICT). Przed wgraniem: 0 operacji ADJUSTMENT
--     w bazie, więc CHECK-i walidowane od razu. Kolumna objęta niemutowalnością (trigger na UPDATE).
-- L4: public.reversed_operation_ids(ids) — które z podanych operacji zostały cofnięte („Moje ostatnie operacje” na
--     terminalu: PRODUKCJA nie widzi przez RLS storna wykonanego przez ADMIN-a).

-- ---------------------------------------------------------------------------
-- L1: adjust_expected
-- ---------------------------------------------------------------------------
alter table public.stock_operations add column adjust_expected numeric(12, 3);
alter table public.stock_operations
  add constraint stock_operations_adjust_expected_valid
  check (
    (type = 'ADJUSTMENT' and adjust_expected is not null and adjust_expected >= 0)
    or (type <> 'ADJUSTMENT' and adjust_expected is null)
  );
comment on column public.stock_operations.adjust_expected is
  'Tylko ADJUSTMENT: stan, który ADMIN widział (expected_current) — stan przed korektą; idempotencja i audyt.';

-- ---------------------------------------------------------------------------
-- L1: stock_adjust zapisuje i porównuje adjust_expected (reszta bez zmian)
-- ---------------------------------------------------------------------------
create or replace function public.stock_adjust(
  p_client_request_id uuid,
  p_material_id uuid,
  p_location_id uuid,
  p_target_quantity numeric,
  p_expected_current numeric,
  p_reason_code text,
  p_reason text default null,
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
  v_mv public.stock_movements%rowtype;
  v_material record;
  v_location record;
  v_current numeric;
  v_delta numeric;
  v_new_qty numeric;
begin
  -- 1. Rola: wyłącznie ADMIN (ROLES.md, ADR 004).
  if v_uid is null or v_role is null or v_role <> 'ADMIN' then
    raise exception 'Korektę stanu może wykonać wyłącznie administrator' using errcode = '42501';
  end if;
  if p_client_request_id is null then
    raise exception 'Brak identyfikatora żądania' using errcode = 'P0001', hint = 'VALIDATION';
  end if;

  -- 2. Idempotencja (advisory lock na id). Te same parametry = ten sam stan widziany (adjust_expected) i ta sama
  -- różnica (czyli ten sam target), materiał, lokalizacja, powód i notatka. Odpowiedź z bieżącym stanem lokalizacji.
  perform pg_advisory_xact_lock(hashtextextended('forbud.stock_op:' || p_client_request_id::text, 0));

  select * into v_op from public.stock_operations o where o.client_request_id = p_client_request_id;
  if found then
    select * into v_mv from public.stock_movements mv where mv.operation_id = v_op.id order by mv.id limit 1;
    if v_op.user_id <> v_uid
       or v_op.type <> 'ADJUSTMENT'
       or v_mv.material_id is distinct from p_material_id
       or v_mv.location_id is distinct from p_location_id
       or v_op.adjust_expected is distinct from p_expected_current
       or v_mv.quantity_delta is distinct from (p_target_quantity - p_expected_current)
       or v_op.reason_code is distinct from p_reason_code
       or v_op.reason is distinct from v_reason
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
      'previous_quantity', v_op.adjust_expected,
      'quantity_delta', v_mv.quantity_delta,
      'new_quantity', coalesce(v_new_qty, 0),
      'idempotent_replay', true
    );
  end if;

  -- 3. Walidacja wejścia (bez blokad)
  if p_reason_code is null or p_reason_code not in (
    'POMYLKA_PRZYJECIA', 'POMYLKA_WYDANIA', 'USZKODZENIE', 'ZAGINIECIE', 'ZNALEZIONE', 'STAN_POCZATKOWY', 'INNY'
  ) then
    raise exception 'Wybierz powód korekty z listy' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  if p_reason_code = 'INNY' and v_reason is null then
    raise exception 'Opisz powód korekty' using errcode = 'P0001', hint = 'REASON_REQUIRED';
  end if;
  if length(v_reason) > 200 or length(v_note) > 500 then
    raise exception 'Opis powodu do 200 znaków, notatka do 500 znaków' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  if p_target_quantity is null or p_target_quantity < 0 or p_target_quantity > 1000000
     or p_target_quantity <> round(p_target_quantity, 3) then
    raise exception 'Faktyczna ilość: od 0 do 1 000 000, do 3 miejsc po przecinku'
      using errcode = 'P0001', hint = 'INVALID_QUANTITY';
  end if;
  if p_expected_current is null or p_expected_current < 0 or p_expected_current <> round(p_expected_current, 3) then
    raise exception 'Brak stanu, który widział użytkownik' using errcode = 'P0001', hint = 'VALIDATION';
  end if;

  -- 4. Blokady: materiał → lokalizacja → wiersz stanu (ADR 010).
  select m.id, m.active, m.allows_fraction into v_material
  from public.materials m
  where m.id = p_material_id
  for no key update;
  if not found then
    raise exception 'Nie znaleziono materiału' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'material';
  end if;
  if not v_material.allows_fraction and p_target_quantity <> trunc(p_target_quantity) then
    raise exception 'Ten materiał liczy się w całych jednostkach' using errcode = 'P0001', hint = 'NOT_INTEGER';
  end if;

  -- FOR SHARE: równoległa dezaktywacja lokalizacji czeka na koniec korekty (albo korekta widzi już nieaktywną).
  select l.id, l.active into v_location
  from public.locations l
  where l.id = p_location_id
  for share;
  if not found then
    raise exception 'Nie znaleziono lokalizacji' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'location';
  end if;

  select s.quantity into v_current
  from public.stock s
  where s.material_id = p_material_id and s.location_id = p_location_id
  for update;
  v_current := coalesce(v_current, 0);

  -- 5. Wyścig: stan inny niż widziany przez ADMIN-a → ponowne potwierdzenie (detail = aktualny stan).
  if v_current <> p_expected_current then
    raise exception 'Stan zmienił się w międzyczasie' using errcode = 'P0001', hint = 'STOCK_CHANGED',
      detail = v_current::text;
  end if;

  v_delta := p_target_quantity - v_current;
  if v_delta = 0 then
    raise exception 'Stan się zgadza — brak korekty' using errcode = 'P0001', hint = 'NO_CHANGE';
  end if;
  -- Nieaktywne: tylko w dół (nie dodajemy towaru do nieaktywnego materiału/lokalizacji).
  if v_delta > 0 and not v_material.active then
    raise exception 'Materiał jest nieaktywny — można tylko zmniejszyć stan' using errcode = 'P0001', hint = 'MATERIAL_INACTIVE';
  end if;
  if v_delta > 0 and not v_location.active then
    raise exception 'Lokalizacja jest nieaktywna — można tylko zmniejszyć stan' using errcode = 'P0001', hint = 'LOCATION_INACTIVE';
  end if;

  -- 6. Zapis: operacja ADJUSTMENT + jeden ruch (delta ≠ 0) + stan. CHECK (quantity >= 0) — ostatnia bariera.
  perform set_config('forbud.stock_write', 'on', true);

  insert into public.stock_operations (type, user_id, client_request_id, reason_code, reason, note, adjust_expected)
  values ('ADJUSTMENT', v_uid, p_client_request_id, p_reason_code, v_reason, v_note, v_current)
  returning * into v_op;

  insert into public.stock_movements (operation_id, material_id, location_id, quantity_delta, user_id, created_at)
  values (v_op.id, p_material_id, p_location_id, v_delta, v_uid, v_op.created_at)
  returning * into v_mv;

  insert into public.stock as s (material_id, location_id, quantity, updated_at)
  values (p_material_id, p_location_id, p_target_quantity, now())
  on conflict (material_id, location_id)
  do update set quantity = s.quantity + v_delta, updated_at = excluded.updated_at
  returning s.quantity into v_new_qty;

  perform set_config('forbud.stock_write', '', true);

  return jsonb_build_object(
    'operation_id', v_op.id,
    'movement_id', v_mv.id,
    'material_id', p_material_id,
    'location_id', p_location_id,
    'previous_quantity', v_current,
    'quantity_delta', v_delta,
    'new_quantity', v_new_qty,
    'idempotent_replay', false
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- L4: które z podanych operacji zostały cofnięte (tylko operacje widoczne dla wywołującego)
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER: storno wykonuje ADMIN, a PRODUKCJA przez RLS widzi tylko własne operacje. Zwracamy wyłącznie id
-- z p_ids, które wywołujący może zobaczyć (PRODUKCJA — własne), i nic więcej o stornie. Maks. 200 id.
create function public.reversed_operation_ids(p_ids uuid[])
returns setof uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role public.app_role := app.user_role();
  v_uid uuid := auth.uid();
begin
  if v_role is null then
    raise exception 'Brak uprawnień' using errcode = '42501';
  end if;
  if p_ids is null or cardinality(p_ids) > 200 then
    raise exception 'Nieprawidłowa lista operacji' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  return query
  select o.id
  from public.stock_operations o
  where o.id = any (p_ids)
    and (v_role in ('ADMIN', 'BIURO') or o.user_id = v_uid)
    and exists (select 1 from public.stock_operations r where r.reverses_operation_id = o.id);
end;
$$;

revoke all on function public.reversed_operation_ids(uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.reversed_operation_ids(uuid[]) to authenticated;
