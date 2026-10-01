-- Etap 5: proste zlecenia produkcyjne, wydania i przesunięcia (ADR 010).
-- Migracja addytywna: nowa tabela production_orders, FK stock_operations.production_order_id (kolumna pusta —
-- sprawdzone przed wgraniem), kolumna stock_operations.reason_code, funkcje stock_issue / stock_transfer,
-- nowa wersja list_stock_movements (zlecenie, powód, przesunięcia). Żadnych zmian istniejących danych.
--
-- Kolejność blokad we wszystkich funkcjach stockowych (ADR 009 L5, rozszerzona w ADR 010):
--   advisory(client_request_id) → materiał(y) FOR NO KEY UPDATE → zlecenie FOR SHARE
--   → lokalizacje FOR SHARE (rosnąco po id) → wiersze stock FOR UPDATE (rosnąco po location_id) → dostawca.

-- ---------------------------------------------------------------------------
-- 1. Zlecenia produkcyjne (Etap 5 — wersja prosta; Etap 8 rozbuduje)
-- ---------------------------------------------------------------------------
create table public.production_orders (
  id uuid primary key default gen_random_uuid(),
  -- Nazwa nadawana przez firmę (np. nazwisko klienta) — NIEunikalna (BUSINESS_RULES).
  name text not null
    constraint production_orders_name_valid check (name = btrim(name) and length(name) between 1 and 120),
  notes text
    constraint production_orders_notes_valid check (notes is null or (notes = btrim(notes) and length(notes) between 1 and 500)),
  status text not null default 'OPEN'
    constraint production_orders_status_valid check (status in ('OPEN', 'DONE', 'CANCELLED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id),
  updated_by uuid references public.profiles (id)
);

create index production_orders_status_created_idx on public.production_orders (status, created_at desc);

comment on table public.production_orders is
  'Zlecenia produkcyjne (nazwa nieunikalna). Nie usuwamy — zmieniamy status (OPEN/DONE/CANCELLED). Wydania wskazują zlecenie.';

-- Kontrola roli (PRZED RLS — wzorzec materiałów/lokalizacji) + normalizacja. Prefiks „a” — przed audytem „b”.
create function app.production_orders_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.app_role;
begin
  if current_setting('role', true) = 'authenticated' then
    v_role := app.user_role();
    if v_role is null or v_role not in ('ADMIN', 'BIURO') then
      raise exception 'Brak uprawnień do zapisu zleceń' using errcode = '42501';
    end if;
  end if;

  new.name := btrim(new.name);
  new.notes := nullif(btrim(new.notes), '');
  return new;
end;
$$;

revoke all on function app.production_orders_before_write() from public, anon, authenticated, service_role;

create trigger production_orders_a_guard_normalize
  before insert or update on public.production_orders
  for each row execute function app.production_orders_before_write();
-- Audyt (created_*/updated_*) ustawia baza z auth.uid() — klient nie może go podrobić (ADR 007).
create trigger production_orders_b_audit
  before insert or update on public.production_orders
  for each row execute function app.catalog_set_audit();

alter table public.production_orders enable row level security;

-- Brak DELETE dla ról aplikacyjnych (wskazują na nie operacje magazynowe). service_role — sprzątanie testów.
revoke all on table public.production_orders from public, anon, authenticated, service_role;
grant select, insert, update on table public.production_orders to authenticated;
grant select, insert, update, delete on table public.production_orders to service_role;

create policy production_orders_select on public.production_orders
  for select to authenticated
  using ((select app.user_role()) is not null);
create policy production_orders_insert on public.production_orders
  for insert to authenticated
  with check ((select app.user_role()) in ('ADMIN', 'BIURO'));
create policy production_orders_update on public.production_orders
  for update to authenticated
  using ((select app.user_role()) in ('ADMIN', 'BIURO'))
  with check ((select app.user_role()) in ('ADMIN', 'BIURO'));

-- ---------------------------------------------------------------------------
-- 2. stock_operations: FK do zleceń, kod powodu wydania
-- ---------------------------------------------------------------------------
-- Kolumna production_order_id była pusta (Etap 4 jej nie wypełniał) — FK bez kaskady (NO ACTION).
alter table public.stock_operations
  add constraint stock_operations_production_order_id_fkey
  foreign key (production_order_id) references public.production_orders (id);

create index stock_operations_production_order_idx
  on public.stock_operations (production_order_id, created_at desc)
  where production_order_id is not null;

alter table public.stock_operations
  add column reason_code text
    constraint stock_operations_reason_code_valid
    check (reason_code is null or reason_code in ('SERWIS', 'USZKODZENIE', 'ZUZYCIE_WLASNE', 'PROBKA', 'INNY'));

-- Ostatnia bariera dla wydania: dokładnie jedno z (zlecenie, powód); „Inny” wymaga opisu.
alter table public.stock_operations
  add constraint stock_operations_issue_target
  check (type <> 'ISSUE' or ((production_order_id is not null) <> (reason_code is not null)));
alter table public.stock_operations
  add constraint stock_operations_reason_other
  check (reason_code is distinct from 'INNY' or reason is not null);

comment on column public.stock_operations.reason_code is
  'Wydanie bez zlecenia: SERWIS, USZKODZENIE, ZUZYCIE_WLASNE, PROBKA, INNY (INNY wymaga opisu w reason).';

-- ---------------------------------------------------------------------------
-- 3. Wydanie: public.stock_issue
-- ---------------------------------------------------------------------------
-- Wydanie z NIEAKTYWNEGO materiału lub NIEAKTYWNEJ lokalizacji jest dozwolone (ADR 010): pozwala wyczyścić
-- stan „starego” miejsca. W praktyce nieaktywne mają stan 0 (dezaktywacja wymaga zera), więc zwykle kończy się
-- INSUFFICIENT_STOCK. Wydanie tylko zmniejsza stan, więc nie łamie blokad dezaktywacji.
create function public.stock_issue(
  p_client_request_id uuid,
  p_location_id uuid,
  p_material_id uuid,
  p_quantity numeric,
  p_production_order_id uuid default null,
  p_reason_code text default null,
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
  v_order_status text;
  v_available numeric;
  v_remaining numeric;
begin
  -- 1. Rola
  if v_uid is null or v_role is null or v_role not in ('PRODUKCJA', 'ADMIN') then
    raise exception 'Brak uprawnień do wydania towaru' using errcode = '42501';
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
       or v_op.note is distinct from v_note then
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
  if p_quantity is null or p_quantity <= 0 or p_quantity > 1000000 or p_quantity <> round(p_quantity, 3) then
    raise exception 'Ilość musi być większa od zera, maksymalnie 1 000 000, do 3 miejsc po przecinku'
      using errcode = 'P0001', hint = 'INVALID_QUANTITY';
  end if;

  -- 4. Blokady (ADR 010): materiał → zlecenie → wiersz stanu.
  -- Materiał FOR NO KEY UPDATE serializuje wszystkie operacje na materiale (przyjęcia, wydania, przesunięcia,
  -- w Etapie 11 rezerwacje). Nieaktywny materiał — dozwolony (patrz komentarz nad funkcją).
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
    if v_order_status <> 'OPEN' then
      raise exception 'Zlecenie jest zamknięte — nie można na nie wydawać' using errcode = 'P0001', hint = 'ORDER_NOT_OPEN';
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

  -- 5. Dostępność.
  -- TU W ETAPIE 11: sprawdzenie dostępności z uwzględnieniem aktywnych rezerwacji INNYCH zleceń
  -- (wolne = Σ stanu materiału − Σ pozostałych aktywnych rezerwacji; wydanie na zlecenie X dozwolone, gdy
  -- ilość ≤ stan w lokalizacji ORAZ ilość ≤ wolne + pozostała rezerwacja X) oraz rozliczenie rezerwacji X
  -- (issued_quantity, status FULFILLED). Rezerwacje blokować PO materiale (materiał już jest zablokowany).
  if p_quantity > v_available then
    raise exception 'Niewystarczający stan w lokalizacji' using errcode = 'P0001', hint = 'INSUFFICIENT_STOCK',
      detail = v_available::text;
  end if;

  -- 6. Zapis (flaga zapisu obejmuje historię i stan; zerowana zaraz potem). CHECK (quantity >= 0) na stock
  -- jest ostatnią barierą.
  perform set_config('forbud.stock_write', 'on', true);

  insert into public.stock_operations (type, user_id, client_request_id, production_order_id, reason_code, reason, note)
  values ('ISSUE', v_uid, p_client_request_id, p_production_order_id, p_reason_code, v_reason, v_note)
  returning * into v_op;

  insert into public.stock_movements (operation_id, material_id, location_id, quantity_delta, user_id, created_at)
  values (v_op.id, p_material_id, p_location_id, -p_quantity, v_uid, v_op.created_at)
  returning * into v_mv;

  update public.stock s
  set quantity = s.quantity - p_quantity, updated_at = now()
  where s.material_id = p_material_id and s.location_id = p_location_id
  returning s.quantity into v_remaining;

  perform set_config('forbud.stock_write', '', true);

  return jsonb_build_object(
    'operation_id', v_op.id,
    'movement_id', v_mv.id,
    'material_id', p_material_id,
    'location_id', p_location_id,
    'quantity', p_quantity,
    'production_order_id', p_production_order_id,
    'reason_code', p_reason_code,
    'remaining_location_quantity', v_remaining,
    'idempotent_replay', false
  );
end;
$$;

revoke all on function public.stock_issue(uuid, uuid, uuid, numeric, uuid, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.stock_issue(uuid, uuid, uuid, numeric, uuid, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Przesunięcie: public.stock_transfer
-- ---------------------------------------------------------------------------
-- 1 operacja TRANSFER + 2 ruchy (−qty z A, +qty do B) w jednej transakcji. Lokalizacja docelowa musi być
-- aktywna (FOR SHARE — jak przyjęcie, bo stan w niej rośnie); źródłowa może być nieaktywna (pozwala opróżnić
-- nieaktywne miejsce). Materiał nieaktywny dozwolony (jak przy wydaniu; w praktyce ma stan 0).
create function public.stock_transfer(
  p_client_request_id uuid,
  p_material_id uuid,
  p_from_location_id uuid,
  p_to_location_id uuid,
  p_quantity numeric,
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
  v_note text := nullif(btrim(p_note), '');
  v_op public.stock_operations%rowtype;
  v_out public.stock_movements%rowtype;
  v_in public.stock_movements%rowtype;
  v_material record;
  v_to_active boolean;
  v_available numeric;
  v_from_qty numeric;
  v_to_qty numeric;
begin
  -- 1. Rola
  if v_uid is null or v_role is null or v_role not in ('PRODUKCJA', 'ADMIN') then
    raise exception 'Brak uprawnień do przesunięcia towaru' using errcode = '42501';
  end if;
  if p_client_request_id is null then
    raise exception 'Brak identyfikatora żądania' using errcode = 'P0001', hint = 'VALIDATION';
  end if;

  -- 2. Idempotencja
  perform pg_advisory_xact_lock(hashtextextended('forbud.stock_op:' || p_client_request_id::text, 0));

  select * into v_op from public.stock_operations o where o.client_request_id = p_client_request_id;
  if found then
    select * into v_out from public.stock_movements mv where mv.operation_id = v_op.id and mv.quantity_delta < 0 limit 1;
    select * into v_in from public.stock_movements mv where mv.operation_id = v_op.id and mv.quantity_delta > 0 limit 1;
    if v_op.user_id <> v_uid
       or v_op.type <> 'TRANSFER'
       or v_out.material_id is distinct from p_material_id
       or v_out.location_id is distinct from p_from_location_id
       or v_in.location_id is distinct from p_to_location_id
       or v_in.quantity_delta is distinct from p_quantity
       or v_op.note is distinct from v_note then
      raise exception 'Ten identyfikator żądania został już użyty dla innej operacji'
        using errcode = 'P0001', hint = 'IDEMPOTENCY_CONFLICT';
    end if;
    select s.quantity into v_from_qty from public.stock s
    where s.material_id = p_material_id and s.location_id = p_from_location_id;
    select s.quantity into v_to_qty from public.stock s
    where s.material_id = p_material_id and s.location_id = p_to_location_id;
    return jsonb_build_object(
      'operation_id', v_op.id,
      'material_id', p_material_id,
      'from_location_id', p_from_location_id,
      'to_location_id', p_to_location_id,
      'quantity', v_in.quantity_delta,
      'from_location_quantity', coalesce(v_from_qty, 0),
      'to_location_quantity', coalesce(v_to_qty, 0),
      'idempotent_replay', true
    );
  end if;

  -- 3. Walidacja wejścia
  if p_from_location_id is null or p_to_location_id is null or p_from_location_id = p_to_location_id then
    raise exception 'Lokalizacja docelowa musi być inna niż źródłowa' using errcode = 'P0001', hint = 'SAME_LOCATION';
  end if;
  if length(v_note) > 500 then
    raise exception 'Notatka do 500 znaków' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  if p_quantity is null or p_quantity <= 0 or p_quantity > 1000000 or p_quantity <> round(p_quantity, 3) then
    raise exception 'Ilość musi być większa od zera, maksymalnie 1 000 000, do 3 miejsc po przecinku'
      using errcode = 'P0001', hint = 'INVALID_QUANTITY';
  end if;

  -- 4. Blokady: materiał → lokalizacje → oba wiersze stanu rosnąco po location_id.
  -- Materiał FOR NO KEY UPDATE serializuje przesunięcia A→B i B→A tego samego materiału (bez zakleszczenia);
  -- stała kolejność wierszy stanu chroni przyszłe operacje wielomateriałowe.
  select m.id, m.allows_fraction into v_material
  from public.materials m
  where m.id = p_material_id
  for no key update;
  if not found then
    raise exception 'Nie znaleziono materiału' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'material';
  end if;
  if not v_material.allows_fraction and p_quantity <> trunc(p_quantity) then
    raise exception 'Ten materiał przesuwa się w całych jednostkach' using errcode = 'P0001', hint = 'NOT_INTEGER';
  end if;

  if not exists (select 1 from public.locations l where l.id = p_from_location_id) then
    raise exception 'Nie znaleziono lokalizacji źródłowej' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'location';
  end if;
  -- Docelowa FOR SHARE: równoległa dezaktywacja czeka (potem LOCATION_NOT_EMPTY) albo przesunięcie widzi
  -- już nieaktywną lokalizację (LOCATION_INACTIVE) — analiza jak dla przyjęcia (ADR 009).
  select l.active into v_to_active
  from public.locations l
  where l.id = p_to_location_id
  for share;
  if not found then
    raise exception 'Nie znaleziono lokalizacji docelowej' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'location';
  end if;
  if not v_to_active then
    raise exception 'Lokalizacja docelowa jest nieaktywna' using errcode = 'P0001', hint = 'LOCATION_INACTIVE';
  end if;

  perform 1
  from public.stock s
  where s.material_id = p_material_id and s.location_id in (p_from_location_id, p_to_location_id)
  order by s.location_id
  for update;

  select s.quantity into v_available
  from public.stock s
  where s.material_id = p_material_id and s.location_id = p_from_location_id;
  v_available := coalesce(v_available, 0);

  -- Przesunięcie nie zmienia łącznego stanu materiału, więc rezerwacje (Etap 11, na poziomie materiału)
  -- go nie ograniczają — wystarczy stan w lokalizacji źródłowej.
  if p_quantity > v_available then
    raise exception 'Niewystarczający stan w lokalizacji źródłowej' using errcode = 'P0001', hint = 'INSUFFICIENT_STOCK',
      detail = v_available::text;
  end if;

  -- 5. Zapis
  perform set_config('forbud.stock_write', 'on', true);

  insert into public.stock_operations (type, user_id, client_request_id, note)
  values ('TRANSFER', v_uid, p_client_request_id, v_note)
  returning * into v_op;

  insert into public.stock_movements (operation_id, material_id, location_id, quantity_delta, user_id, created_at)
  values (v_op.id, p_material_id, p_from_location_id, -p_quantity, v_uid, v_op.created_at)
  returning * into v_out;
  insert into public.stock_movements (operation_id, material_id, location_id, quantity_delta, user_id, created_at)
  values (v_op.id, p_material_id, p_to_location_id, p_quantity, v_uid, v_op.created_at)
  returning * into v_in;

  update public.stock s
  set quantity = s.quantity - p_quantity, updated_at = now()
  where s.material_id = p_material_id and s.location_id = p_from_location_id
  returning s.quantity into v_from_qty;

  insert into public.stock as s (material_id, location_id, quantity, updated_at)
  values (p_material_id, p_to_location_id, p_quantity, now())
  on conflict (material_id, location_id)
  do update set quantity = s.quantity + excluded.quantity, updated_at = excluded.updated_at
  returning s.quantity into v_to_qty;

  perform set_config('forbud.stock_write', '', true);

  return jsonb_build_object(
    'operation_id', v_op.id,
    'material_id', p_material_id,
    'from_location_id', p_from_location_id,
    'to_location_id', p_to_location_id,
    'quantity', p_quantity,
    'from_location_quantity', v_from_qty,
    'to_location_quantity', v_to_qty,
    'idempotent_replay', false
  );
end;
$$;

revoke all on function public.stock_transfer(uuid, uuid, uuid, uuid, numeric, text) from public, anon, authenticated, service_role;
grant execute on function public.stock_transfer(uuid, uuid, uuid, uuid, numeric, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. list_stock_movements: zlecenie, powód, przesunięcia (skąd → dokąd)
-- ---------------------------------------------------------------------------
-- Nowe parametry: p_production_order_id (filtr), p_collapse_transfers (przesunięcie jako JEDEN wiersz —
-- ruch przychodzący, z kodami „skąd”/„dokąd”). PRODUKCJA nadal widzi wyłącznie własne ruchy.
drop function public.list_stock_movements(text, text, date, date, integer, integer, timestamptz);

create function public.list_stock_movements(
  p_type text default null,
  p_material_q text default null,
  p_date_from date default null,
  p_date_to date default null,
  p_page integer default 1,
  p_page_size integer default 50,
  p_since timestamptz default null,
  p_production_order_id uuid default null,
  p_collapse_transfers boolean default false
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
  if p_type is not null and p_type not in ('RECEIPT', 'ISSUE', 'TRANSFER', 'ADJUSTMENT', 'INVENTORY') then
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

  select count(*) into v_total
  from public.stock_movements mv
  join public.stock_operations o on o.id = mv.operation_id
  join public.materials m on m.id = mv.material_id
  where (p_type is null or o.type = p_type)
    and (v_only is null or mv.user_id = v_only)
    and (p_production_order_id is null or o.production_order_id = p_production_order_id)
    and (not v_collapse or o.type <> 'TRANSFER' or mv.quantity_delta > 0)
    and (v_pattern is null or m.code ilike v_pattern or m.name ilike v_pattern)
    and (v_from is null or mv.created_at >= v_from)
    and (v_to is null or mv.created_at < v_to);

  select coalesce(jsonb_agg(row_data order by created_at desc, id desc), '[]'::jsonb) into v_items
  from (
    select
      mv.created_at,
      mv.id,
      jsonb_build_object(
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
        'to_location_code', tr.to_code
      ) as row_data
    from public.stock_movements mv
    join public.stock_operations o on o.id = mv.operation_id
    join public.materials m on m.id = mv.material_id
    join public.locations l on l.id = mv.location_id
    join public.profiles p on p.id = mv.user_id
    left join public.suppliers sp on sp.id = o.supplier_id
    left join public.production_orders po on po.id = o.production_order_id
    left join lateral (
      select
        max(l2.code) filter (where m2.quantity_delta < 0) as from_code,
        max(l2.code) filter (where m2.quantity_delta > 0) as to_code
      from public.stock_movements m2
      join public.locations l2 on l2.id = m2.location_id
      where m2.operation_id = o.id and o.type = 'TRANSFER'
    ) tr on true
    where (p_type is null or o.type = p_type)
      and (v_only is null or mv.user_id = v_only)
      and (p_production_order_id is null or o.production_order_id = p_production_order_id)
      and (not v_collapse or o.type <> 'TRANSFER' or mv.quantity_delta > 0)
      and (v_pattern is null or m.code ilike v_pattern or m.name ilike v_pattern)
      and (v_from is null or mv.created_at >= v_from)
      and (v_to is null or mv.created_at < v_to)
    order by mv.created_at desc, mv.id desc
    limit p_page_size offset (p_page - 1) * p_page_size
  ) q;

  return jsonb_build_object('total', v_total, 'items', v_items);
end;
$$;

revoke all on function public.list_stock_movements(text, text, date, date, integer, integer, timestamptz, uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.list_stock_movements(text, text, date, date, integer, integer, timestamptz, uuid, boolean) to authenticated;
