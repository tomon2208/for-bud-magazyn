-- Etap 6: korekty stanu (ADMIN), cofanie operacji (storno, ADMIN) i historia ruchów (ADR 011).
-- Migracja addytywna: nowy typ operacji REVERSAL, kolumna reverses_operation_id (FK + UNIQUE), CHECK powodu
-- per typ operacji, indeksy pod filtry historii, funkcje stock_adjust / stock_reverse / list_user_names,
-- nowe wersje list_stock_movements i order_issue_summary. Istniejące wiersze spełniają nowe CHECK-i (sprawdzone
-- przed wgraniem: same RECEIPT bez kodu powodu). Żadnych zmian danych.
--
-- Kolejność blokad (ADR 010, rozszerzona w ADR 011):
--   advisory(client_request_id) → [storno: oryginalna operacja FOR NO KEY UPDATE] → materiał(y) FOR NO KEY UPDATE
--   (rosnąco po id) → zlecenie FOR SHARE → lokalizacje FOR SHARE (rosnąco po id)
--   → wiersze stock FOR UPDATE (rosnąco po material_id, location_id) → dostawca.

-- ---------------------------------------------------------------------------
-- 1. stock_operations: typ REVERSAL, powiązanie storna z oryginałem, powody per typ
-- ---------------------------------------------------------------------------
alter table public.stock_operations drop constraint stock_operations_type_valid;
alter table public.stock_operations
  add constraint stock_operations_type_valid
  check (type in ('RECEIPT', 'ISSUE', 'TRANSFER', 'ADJUSTMENT', 'INVENTORY', 'REVERSAL'));

-- Storno wskazuje operację, którą cofa. UNIQUE: operację da się cofnąć tylko raz (ostatnia bariera — funkcja
-- sprawdza to wcześniej pod blokadą). FK bez kaskady; operacje i tak są niemutowalne (trigger), także ta kolumna.
alter table public.stock_operations
  add column reverses_operation_id uuid
    constraint stock_operations_reverses_operation_id_fkey references public.stock_operations (id);
alter table public.stock_operations
  add constraint stock_operations_reverses_operation_id_key unique (reverses_operation_id);
-- REVERSAL ⇔ wskazanie oryginału; storno wymaga opisu powodu (≥ 3 znaki).
alter table public.stock_operations
  add constraint stock_operations_reversal_link
  check ((type = 'REVERSAL') = (reverses_operation_id is not null));
alter table public.stock_operations
  add constraint stock_operations_reversal_reason
  check (type <> 'REVERSAL' or (reason is not null and length(reason) >= 3));

-- Kody powodów walidowane per typ operacji (część kodów wspólna dla wydań i korekt: USZKODZENIE, INNY).
-- Korekta zawsze ma kod powodu; storno nie ma kodu (tylko opis). INNY ⇒ opis (stock_operations_reason_other).
alter table public.stock_operations drop constraint stock_operations_reason_code_valid;
alter table public.stock_operations
  add constraint stock_operations_reason_code_valid
  check (
    reason_code is null
    or (type = 'ISSUE' and reason_code in ('SERWIS', 'USZKODZENIE', 'ZUZYCIE_WLASNE', 'PROBKA', 'INNY'))
    or (type = 'ADJUSTMENT' and reason_code in (
      'POMYLKA_PRZYJECIA', 'POMYLKA_WYDANIA', 'USZKODZENIE', 'ZAGINIECIE', 'ZNALEZIONE', 'STAN_POCZATKOWY', 'INNY'
    ))
  );
alter table public.stock_operations
  add constraint stock_operations_adjustment_reason
  check (type <> 'ADJUSTMENT' or reason_code is not null);

comment on column public.stock_operations.reason_code is
  'Wydanie bez zlecenia: SERWIS, USZKODZENIE, ZUZYCIE_WLASNE, PROBKA, INNY. Korekta: POMYLKA_PRZYJECIA, POMYLKA_WYDANIA, USZKODZENIE, ZAGINIECIE, ZNALEZIONE, STAN_POCZATKOWY, INNY. INNY wymaga opisu w reason.';
comment on column public.stock_operations.reverses_operation_id is
  'Tylko REVERSAL: operacja cofnięta tym stornem (unikalne — operację cofa się raz).';

-- Indeksy pod filtry historii (użytkownik, sama data) — lokalizacja/materiał/zlecenie mają już indeksy.
create index stock_movements_user_created_idx on public.stock_movements (user_id, created_at desc);
create index stock_movements_created_idx on public.stock_movements (created_at desc, id desc);

-- ---------------------------------------------------------------------------
-- 2. Korekta: public.stock_adjust — „ustaw stan na X” (tylko ADMIN)
-- ---------------------------------------------------------------------------
-- ADMIN podaje faktyczną ilość (p_target_quantity ≥ 0) i stan, który widział (p_expected_current). Pod blokadą
-- materiału i wiersza stanu: stan ≠ widziany → STOCK_CHANGED (detail = aktualny stan) — chroni przed nadpisaniem
-- ruchu z międzyczasu; różnica 0 → NO_CHANGE (nic nie zapisujemy). Nieaktywny materiał/lokalizacja: tylko korekta,
-- która nie zwiększa stanu (wyzerowanie przed dezaktywacją).
create function public.stock_adjust(
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

  -- 2. Idempotencja (advisory lock na id). Te same parametry = ta sama różnica (target − expected), materiał,
  -- lokalizacja, powód i notatka. Odpowiedź z bieżącym stanem lokalizacji.
  perform pg_advisory_xact_lock(hashtextextended('forbud.stock_op:' || p_client_request_id::text, 0));

  select * into v_op from public.stock_operations o where o.client_request_id = p_client_request_id;
  if found then
    select * into v_mv from public.stock_movements mv where mv.operation_id = v_op.id order by mv.id limit 1;
    if v_op.user_id <> v_uid
       or v_op.type <> 'ADJUSTMENT'
       or v_mv.material_id is distinct from p_material_id
       or v_mv.location_id is distinct from p_location_id
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
      'previous_quantity', p_expected_current,
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

  insert into public.stock_operations (type, user_id, client_request_id, reason_code, reason, note)
  values ('ADJUSTMENT', v_uid, p_client_request_id, p_reason_code, v_reason, v_note)
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

revoke all on function public.stock_adjust(uuid, uuid, uuid, numeric, numeric, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.stock_adjust(uuid, uuid, uuid, numeric, numeric, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Storno: public.stock_reverse — „Cofnij ten ruch” (tylko ADMIN)
-- ---------------------------------------------------------------------------
-- Tworzy operację REVERSAL z ruchami odwrotnymi do WSZYSTKICH ruchów oryginału (przesunięcie → 2 ruchy).
-- Oryginał zostaje bez zmian (niemutowalny); „cofnięto” wynika z powiązania reverses_operation_id.
-- Nie można cofnąć storna ani operacji już cofniętej; stan w żadnej lokalizacji nie może spaść < 0
-- (INSUFFICIENT_STOCK, detail = {"available", "location_code"}); nie zwiększa stanu nieaktywnej lokalizacji ani
-- nieaktywnego materiału (spójnie z korektą). Storno wydania na zlecenie zachowuje zlecenie (production_order_id).
create function public.stock_reverse(
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

  -- 7. Zapis: operacja REVERSAL (zlecenie z oryginału) + ruchy odwrotne + stany.
  perform set_config('forbud.stock_write', 'on', true);

  insert into public.stock_operations (type, user_id, client_request_id, production_order_id, reverses_operation_id, reason, note)
  values ('REVERSAL', v_uid, p_client_request_id, v_orig.production_order_id, p_operation_id, v_reason, v_note)
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

revoke all on function public.stock_reverse(uuid, uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.stock_reverse(uuid, uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Podsumowanie wydań na zlecenie z uwzględnieniem storn (ADR 010 „Uwagi na Etap 6”)
-- ---------------------------------------------------------------------------
-- Storno wydania ma production_order_id oryginału, więc suma ISSUE + REVERSAL zlecenia = wydano netto.
-- issues — liczba wydań, reversals — liczba cofniętych. SECURITY INVOKER (RLS jak dotąd).
drop function public.order_issue_summary(uuid);

create function public.order_issue_summary(p_order_id uuid)
returns table (
  material_id uuid,
  material_code text,
  material_name text,
  unit text,
  quantity numeric,
  issues integer,
  reversals integer
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
    (count(*) filter (where o.type = 'REVERSAL'))::integer as reversals
  from public.stock_movements mv
  join public.stock_operations o on o.id = mv.operation_id
  join public.materials m on m.id = mv.material_id
  where o.production_order_id = p_order_id
    and o.type in ('ISSUE', 'REVERSAL')
  group by m.id, m.code, m.name, m.unit
  order by m.code
$$;

revoke all on function public.order_issue_summary(uuid) from public, anon, authenticated, service_role;
grant execute on function public.order_issue_summary(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Historia ruchów: list_stock_movements z filtrami materiału/lokalizacji/użytkownika/operacji i stornami
-- ---------------------------------------------------------------------------
-- Nowe parametry (wartości domyślne — dotychczasowe wywołania działają): p_material_id, p_location_id,
-- p_user_id, p_operation_id (operacja ALBO jej storno). Typ REVERSAL. Przesunięcie i storno przesunięcia przy
-- p_collapse_transfers = jeden wiersz (ruch przychodzący, „skąd → dokąd”); filtr lokalizacji obejmuje wtedy obie
-- strony. Pola: cofnięcie (kto/kiedy/powód), cofana operacja (typ/data), reversible. PRODUKCJA — tylko własne.
-- Filtrowanie i paginacja w SQL.
drop function public.list_stock_movements(text, text, date, date, integer, integer, timestamptz, uuid, boolean);

create function public.list_stock_movements(
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
      'reversible', (o.type <> 'REVERSAL' and rv.id is null)
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

revoke all on function public.list_stock_movements(text, text, date, date, integer, integer, timestamptz, uuid, boolean, uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_stock_movements(text, text, date, date, integer, integer, timestamptz, uuid, boolean, uuid, uuid, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Lista użytkowników do filtra historii (ADMIN, BIURO) — wyłącznie id, imię i nazwisko, aktywność
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER: BIURO widzi w profiles tylko siebie. Zwracamy tylko to, co i tak widać w historii (nazwisko).
create function public.list_user_names()
returns table (id uuid, full_name text, active boolean)
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
  select p.id, p.full_name, p.active
  from public.profiles p
  order by p.active desc, p.full_name;
end;
$$;

revoke all on function public.list_user_names() from public, anon, authenticated, service_role;
grant execute on function public.list_user_names() to authenticated;
