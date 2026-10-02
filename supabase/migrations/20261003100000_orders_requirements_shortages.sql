-- Etap 8–10: rozbudowa zleceń (numer, status „W produkcji”), zapotrzebowanie (listy niezmienne, sumowane)
-- i braki (liczone w SQL). ADR 013. Migracja addytywna: nowe kolumny/tabele/funkcje + minimalna zmiana
-- stock_issue (wydanie dozwolone także dla IN_PRODUCTION) i CHECK statusu zleceń.
--
-- Etap 11 (rezerwacje) — miejsca zmiany: app.requirement_balance (potrzebne/wydano/pozostało) zostaje;
-- „dostępne” (app.material_available) powinno stać się „stan − aktywne rezerwacje innych zleceń”.

-- ---------------------------------------------------------------------------
-- 1. Zlecenia: numer + status IN_PRODUCTION
-- ---------------------------------------------------------------------------
alter table public.production_orders
  add column number text
    constraint production_orders_number_valid check (number is null or (number = btrim(number) and length(number) between 1 and 50));

-- Numer unikalny bez względu na wielkość liter, gdy podany (NULL — wiele zleceń bez numeru).
create unique index production_orders_number_unique on public.production_orders (lower(number)) where number is not null;

alter table public.production_orders drop constraint production_orders_status_valid;
alter table public.production_orders
  add constraint production_orders_status_valid check (status in ('OPEN', 'IN_PRODUCTION', 'DONE', 'CANCELLED'));

comment on column public.production_orders.number is 'Opcjonalny numer zlecenia nadawany przez firmę (unikalny bez względu na wielkość liter).';

-- Normalizacja numeru (puste → NULL) w istniejącym triggerze; kontrola roli nadal pierwsza.
create or replace function app.production_orders_before_write()
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
  new.number := nullif(btrim(new.number), '');
  new.notes := nullif(btrim(new.notes), '');
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. stock_issue: wydanie dozwolone dla OPEN i IN_PRODUCTION (jedyna zmiana: warunek statusu zlecenia)
-- ---------------------------------------------------------------------------
create or replace function public.stock_issue(
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


-- ---------------------------------------------------------------------------
-- 3. Zapotrzebowanie: requirements (listy) + requirement_items (pozycje)
-- ---------------------------------------------------------------------------
-- Zlecenie może mieć wiele list; zapotrzebowanie zlecenia = suma pozycji list ACTIVE. Lista jest NIEZMIENNA po
-- utworzeniu: błąd poprawia się przez wycofanie (z powodem) i utworzenie poprawionej kopii. Zapis wyłącznie przez
-- funkcje create_requirement / withdraw_requirement (role BIURO/ADMIN) — role aplikacyjne mają tylko SELECT.
create table public.requirements (
  id uuid primary key default gen_random_uuid(),
  production_order_id uuid not null references public.production_orders (id),
  -- IMPORT: Etap 12 (LiczOkno); imported_file_name / import_format opisują plik źródłowy.
  source text not null default 'MANUAL'
    constraint requirements_source_valid check (source in ('MANUAL', 'IMPORT')),
  name text not null
    constraint requirements_name_valid check (name = btrim(name) and length(name) between 1 and 120),
  imported_file_name text
    constraint requirements_file_valid check (imported_file_name is null or length(imported_file_name) between 1 and 255),
  import_format text
    constraint requirements_format_valid check (import_format is null or length(import_format) between 1 and 100),
  status text not null default 'ACTIVE'
    constraint requirements_status_valid check (status in ('ACTIVE', 'WITHDRAWN')),
  withdrawn_at timestamptz,
  withdrawn_by uuid references public.profiles (id),
  withdraw_reason text
    constraint requirements_withdraw_reason_valid
    check (withdraw_reason is null or (withdraw_reason = btrim(withdraw_reason) and length(withdraw_reason) between 3 and 200)),
  client_request_id uuid unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id),
  updated_by uuid references public.profiles (id),
  constraint requirements_withdrawn_consistent check (
    (status = 'ACTIVE' and withdrawn_at is null and withdrawn_by is null and withdraw_reason is null)
    or (status = 'WITHDRAWN' and withdrawn_at is not null and withdraw_reason is not null)
  )
);

create index requirements_order_idx on public.requirements (production_order_id, status);

create table public.requirement_items (
  id uuid primary key default gen_random_uuid(),
  requirement_id uuid not null references public.requirements (id) on delete cascade,
  material_id uuid not null references public.materials (id),
  quantity numeric(12, 3) not null
    constraint requirement_items_quantity_valid check (quantity > 0 and quantity <= 1000000),
  note text
    constraint requirement_items_note_valid check (note is null or (note = btrim(note) and length(note) between 1 and 200)),
  -- Etap 12: oryginalny kod/wiersz z pliku (tylko referencja; specyfika Excela nie przenika do domeny).
  raw_source_ref text
    constraint requirement_items_raw_valid check (raw_source_ref is null or length(raw_source_ref) between 1 and 200),
  created_at timestamptz not null default now(),
  -- W jednej liście materiał występuje raz.
  constraint requirement_items_unique_material unique (requirement_id, material_id)
);

create index requirement_items_material_idx on public.requirement_items (material_id);

comment on table public.requirements is
  'Listy zapotrzebowania zlecenia (niezmienne; wycofywane z powodem). Zapotrzebowanie zlecenia = suma pozycji list ACTIVE.';

-- Strażnik list: INSERT zawsze jako ACTIVE; UPDATE wyłącznie przejście ACTIVE → WITHDRAWN (reszta kolumn bez zmian).
create function app.requirements_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.status := 'ACTIVE';
    new.withdrawn_at := null;
    new.withdrawn_by := null;
    new.withdraw_reason := null;
    new.name := btrim(new.name);
    return new;
  end if;
  if old.status <> 'ACTIVE' or new.status <> 'WITHDRAWN'
     or new.production_order_id is distinct from old.production_order_id
     or new.source is distinct from old.source
     or new.name is distinct from old.name
     or new.imported_file_name is distinct from old.imported_file_name
     or new.import_format is distinct from old.import_format
     or new.client_request_id is distinct from old.client_request_id then
    raise exception 'Lista zapotrzebowania jest niezmienna — można ją tylko wycofać' using errcode = 'P0001', hint = 'IMMUTABLE';
  end if;
  new.withdrawn_at := now();
  new.withdrawn_by := auth.uid();
  return new;
end;
$$;
revoke all on function app.requirements_guard() from public, anon, authenticated, service_role;

create trigger requirements_a_guard
  before insert or update on public.requirements
  for each row execute function app.requirements_guard();
create trigger requirements_b_audit
  before insert or update on public.requirements
  for each row execute function app.catalog_set_audit();

-- Pozycje: ilość zgodna z allows_fraction; UPDATE zabroniony zawsze.
create function app.requirement_items_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_allows boolean;
begin
  if tg_op = 'UPDATE' then
    raise exception 'Pozycje zapotrzebowania są niezmienne' using errcode = 'P0001', hint = 'IMMUTABLE';
  end if;
  select m.allows_fraction into v_allows from public.materials m where m.id = new.material_id;
  if v_allows is false and new.quantity <> trunc(new.quantity) then
    raise exception 'Ten materiał liczy się w całych jednostkach' using errcode = 'P0001', hint = 'NOT_INTEGER';
  end if;
  new.note := nullif(btrim(new.note), '');
  return new;
end;
$$;
revoke all on function app.requirement_items_guard() from public, anon, authenticated, service_role;

create trigger requirement_items_guard
  before insert or update on public.requirement_items
  for each row execute function app.requirement_items_guard();

alter table public.requirements enable row level security;
alter table public.requirement_items enable row level security;

-- Role aplikacyjne: tylko SELECT (zapis przez funkcje). service_role: SELECT + DELETE — wyłącznie sprzątanie testów.
revoke all on table public.requirements, public.requirement_items from public, anon, authenticated, service_role;
grant select on table public.requirements, public.requirement_items to authenticated;
grant select, delete on table public.requirements, public.requirement_items to service_role;

create policy requirements_select on public.requirements
  for select to authenticated using ((select app.user_role()) is not null);
create policy requirement_items_select on public.requirement_items
  for select to authenticated using ((select app.user_role()) is not null);

-- ---------------------------------------------------------------------------
-- 4. create_requirement / withdraw_requirement
-- ---------------------------------------------------------------------------
-- p_items: tablica {material_id, quantity, note?}; 1–500 pozycji, materiał raz, materiały aktywne, ilość > 0
-- (do 3 miejsc, całkowita gdy !allows_fraction). Zlecenie musi być OPEN / IN_PRODUCTION (FOR SHARE — zamknięcie
-- zlecenia w trakcie czeka). Idempotencja po p_client_request_id (podwójne kliknięcie / retry sieci).
create function public.create_requirement(
  p_order_id uuid,
  p_name text,
  p_items jsonb,
  p_client_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role public.app_role := app.user_role();
  v_name text := btrim(p_name);
  v_status text;
  v_req public.requirements%rowtype;
  v_count integer;
  v_distinct integer;
  v_bad text;
begin
  if v_uid is null or v_role is null or v_role not in ('ADMIN', 'BIURO') then
    raise exception 'Brak uprawnień do tworzenia zapotrzebowania' using errcode = '42501';
  end if;

  if p_client_request_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('forbud.requirement:' || p_client_request_id::text, 0));
    select * into v_req from public.requirements r where r.client_request_id = p_client_request_id;
    if found then
      if v_req.created_by is distinct from v_uid or v_req.production_order_id is distinct from p_order_id then
        raise exception 'Ten identyfikator żądania został już użyty' using errcode = 'P0001', hint = 'IDEMPOTENCY_CONFLICT';
      end if;
      return jsonb_build_object(
        'requirement_id', v_req.id,
        'item_count', (select count(*) from public.requirement_items i where i.requirement_id = v_req.id),
        'idempotent_replay', true
      );
    end if;
  end if;

  if v_name is null or length(v_name) not between 1 and 120 then
    raise exception 'Nazwa listy: 1–120 znaków' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 500 then
    raise exception 'Lista musi mieć od 1 do 500 pozycji' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  if exists (select 1 from jsonb_array_elements(p_items) e where jsonb_typeof(e) <> 'object') then
    raise exception 'Nieprawidłowa pozycja listy' using errcode = 'P0001', hint = 'VALIDATION';
  end if;

  -- Rzutowania (uuid / numeric) przy złym formacie dają 22P02 (API: 400 VALIDATION).
  select count(*), count(distinct x.material_id) into v_count, v_distinct
  from jsonb_to_recordset(p_items) as x(material_id uuid, quantity numeric, note text);
  if exists (select 1 from jsonb_to_recordset(p_items) as x(material_id uuid, quantity numeric, note text) where x.material_id is null) then
    raise exception 'Pozycja bez materiału' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  if v_distinct < v_count then
    raise exception 'Ten sam materiał występuje na liście więcej niż raz' using errcode = 'P0001', hint = 'DUPLICATE_MATERIAL';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_items) as x(material_id uuid, quantity numeric, note text)
    where x.quantity is null or x.quantity <= 0 or x.quantity > 1000000 or x.quantity <> round(x.quantity, 3)
  ) then
    raise exception 'Ilość musi być większa od zera, maksymalnie 1 000 000, do 3 miejsc po przecinku'
      using errcode = 'P0001', hint = 'INVALID_QUANTITY';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_items) as x(material_id uuid, quantity numeric, note text)
    where length(btrim(x.note)) > 200
  ) then
    raise exception 'Notatka pozycji: do 200 znaków' using errcode = 'P0001', hint = 'VALIDATION';
  end if;

  -- Zlecenie FOR SHARE: zmiana statusu (UPDATE) czeka na koniec tworzenia listy.
  select po.status into v_status from public.production_orders po where po.id = p_order_id for share;
  if not found then
    raise exception 'Nie znaleziono zlecenia' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'order';
  end if;
  if v_status not in ('OPEN', 'IN_PRODUCTION') then
    raise exception 'Zlecenie jest zakończone lub anulowane — otwórz je ponownie, aby dodać listę'
      using errcode = 'P0001', hint = 'ORDER_NOT_OPEN';
  end if;

  if exists (
    select 1 from jsonb_to_recordset(p_items) as x(material_id uuid, quantity numeric, note text)
    where not exists (select 1 from public.materials m where m.id = x.material_id)
  ) then
    raise exception 'Nie znaleziono materiału' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'material';
  end if;
  select m.code into v_bad
  from jsonb_to_recordset(p_items) as x(material_id uuid, quantity numeric, note text)
  join public.materials m on m.id = x.material_id
  where not m.active
  order by m.code limit 1;
  if v_bad is not null then
    raise exception 'Materiał jest nieaktywny' using errcode = 'P0001', hint = 'MATERIAL_INACTIVE', detail = v_bad;
  end if;
  select m.code into v_bad
  from jsonb_to_recordset(p_items) as x(material_id uuid, quantity numeric, note text)
  join public.materials m on m.id = x.material_id
  where not m.allows_fraction and x.quantity <> trunc(x.quantity)
  order by m.code limit 1;
  if v_bad is not null then
    raise exception 'Ten materiał liczy się w całych jednostkach' using errcode = 'P0001', hint = 'NOT_INTEGER', detail = v_bad;
  end if;

  insert into public.requirements (production_order_id, source, name, client_request_id)
  values (p_order_id, 'MANUAL', v_name, p_client_request_id)
  returning * into v_req;

  insert into public.requirement_items (requirement_id, material_id, quantity, note)
  select v_req.id, x.material_id, x.quantity, nullif(btrim(x.note), '')
  from jsonb_to_recordset(p_items) as x(material_id uuid, quantity numeric, note text);

  return jsonb_build_object('requirement_id', v_req.id, 'item_count', v_count, 'idempotent_replay', false);
end;
$$;

revoke all on function public.create_requirement(uuid, text, jsonb, uuid) from public, anon, authenticated, service_role;
grant execute on function public.create_requirement(uuid, text, jsonb, uuid) to authenticated;

create function public.withdraw_requirement(p_requirement_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role public.app_role := app.user_role();
  v_reason text := btrim(p_reason);
  v_status text;
begin
  if v_uid is null or v_role is null or v_role not in ('ADMIN', 'BIURO') then
    raise exception 'Brak uprawnień do wycofania zapotrzebowania' using errcode = '42501';
  end if;
  if v_reason is null or length(v_reason) not between 3 and 200 then
    raise exception 'Podaj powód wycofania (3–200 znaków)' using errcode = 'P0001', hint = 'VALIDATION';
  end if;

  select r.status into v_status from public.requirements r where r.id = p_requirement_id for update;
  if not found then
    raise exception 'Nie znaleziono listy' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'requirement';
  end if;
  if v_status = 'WITHDRAWN' then
    raise exception 'Lista została już wycofana' using errcode = 'P0001', hint = 'ALREADY_WITHDRAWN';
  end if;

  update public.requirements r set status = 'WITHDRAWN', withdraw_reason = v_reason where r.id = p_requirement_id;
  return jsonb_build_object('requirement_id', p_requirement_id, 'status', 'WITHDRAWN');
end;
$$;

revoke all on function public.withdraw_requirement(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.withdraw_requirement(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Braki (liczone w SQL)
-- ---------------------------------------------------------------------------
-- potrzebne  = suma pozycji list ACTIVE zlecenia
-- wydano     = netto wydane na zlecenie (ISSUE − storna; jak order_issue_summary)
-- pozostało  = max(potrzebne − wydano, 0)
-- dostępne   = stan łączny materiału w AKTYWNYCH lokalizacjach
-- brakuje    = max(pozostało − dostępne, 0)
-- Zbiorczo (wszystkie zlecenia OPEN + IN_PRODUCTION): Σ pozostało per materiał, „dostępne” liczone RAZ.
--
-- ETAP 11 (rezerwacje): „dostępne” w app.shortage_available ma stać się „stan − aktywne rezerwacje INNYCH zleceń”
-- (per zlecenie: + własna rezerwacja), a „pozostało” zostaje bez zmian.
--
-- Funkcje są SECURITY DEFINER z kontrolą roli: PRODUKCJA widzi z RLS tylko własne ruchy, więc „wydano netto”
-- (wszyscy użytkownicy) policzy tylko definer; kontrola roli w każdej funkcji publicznej, search_path pusty.

-- Potrzebne / wydano / pozostało per (zlecenie, materiał). NULL = wszystkie zlecenia OPEN + IN_PRODUCTION.
create function app.requirement_balance(p_order_ids uuid[] default null)
returns table (production_order_id uuid, material_id uuid, needed numeric, issued numeric, remaining numeric)
language sql
stable
security definer
set search_path = ''
as $$
  with need as (
    select r.production_order_id, i.material_id, sum(i.quantity) as needed
    from public.requirements r
    join public.requirement_items i on i.requirement_id = r.id
    join public.production_orders po on po.id = r.production_order_id
    where r.status = 'ACTIVE'
      and case
            when p_order_ids is null then po.status in ('OPEN', 'IN_PRODUCTION')
            else r.production_order_id = any (p_order_ids)
          end
    group by r.production_order_id, i.material_id
  ), iss as (
    select o.production_order_id, mv.material_id, -sum(mv.quantity_delta) as issued
    from public.stock_operations o
    join public.stock_movements mv on mv.operation_id = o.id
    where o.type in ('ISSUE', 'REVERSAL')
      and o.production_order_id in (select n.production_order_id from need n)
    group by o.production_order_id, mv.material_id
  )
  select n.production_order_id, n.material_id, n.needed,
         coalesce(s.issued, 0),
         greatest(n.needed - coalesce(s.issued, 0), 0)
  from need n
  left join iss s on s.production_order_id = n.production_order_id and s.material_id = n.material_id
$$;
revoke all on function app.requirement_balance(uuid[]) from public, anon, authenticated, service_role;

-- Dostępne: stan łączny materiałów w AKTYWNYCH lokalizacjach (Etap 11: minus rezerwacje).
create function app.shortage_available(p_material_ids uuid[])
returns table (material_id uuid, available numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select s.material_id, sum(s.quantity)
  from public.stock s
  join public.locations l on l.id = s.location_id and l.active
  where s.material_id = any (p_material_ids)
  group by s.material_id
$$;
revoke all on function app.shortage_available(uuid[]) from public, anon, authenticated, service_role;

-- Braki zbiorczo per materiał (zlecenia OPEN + IN_PRODUCTION).
create function app.shortage_rows(p_supplier_id uuid, p_category_id uuid, p_only_short boolean)
returns table (
  material_id uuid, material_code text, material_name text, unit text,
  category_id uuid, category_name text, supplier_id uuid, supplier_name text,
  remaining numeric, available numeric, shortage numeric, orders jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  with per_mat as (
    select b.material_id,
           sum(b.remaining) as remaining,
           jsonb_agg(
             jsonb_build_object('order_id', b.production_order_id, 'number', po.number, 'name', po.name, 'remaining', b.remaining)
             order by po.created_at, po.id) as orders
    from app.requirement_balance(null) b
    join public.production_orders po on po.id = b.production_order_id
    where b.remaining > 0
    group by b.material_id
  ), avail as (
    select a.material_id, a.available
    from app.shortage_available((select coalesce(array_agg(p.material_id), '{}') from per_mat p)) a
  )
  select m.id, m.code, m.name, m.unit, c.id, c.name, su.id, su.name,
         pm.remaining, coalesce(a.available, 0), greatest(pm.remaining - coalesce(a.available, 0), 0), pm.orders
  from per_mat pm
  join public.materials m on m.id = pm.material_id
  join public.material_categories c on c.id = m.category_id
  left join public.suppliers su on su.id = m.default_supplier_id
  left join avail a on a.material_id = pm.material_id
  where (p_supplier_id is null or m.default_supplier_id = p_supplier_id)
    and (p_category_id is null or m.category_id = p_category_id)
    and (not coalesce(p_only_short, false) or pm.remaining > coalesce(a.available, 0))
$$;
revoke all on function app.shortage_rows(uuid, uuid, boolean) from public, anon, authenticated, service_role;

-- Zbiorczo: wiersze do strony „Braki” (ADMIN, BIURO). Sortowanie: dostawca (bez dostawcy na końcu), brak malejąco, kod.
create function public.shortages_summary(
  p_supplier_id uuid default null,
  p_category_id uuid default null,
  p_only_short boolean default true
)
returns table (
  material_id uuid, material_code text, material_name text, unit text,
  category_id uuid, category_name text, supplier_id uuid, supplier_name text,
  remaining numeric, available numeric, shortage numeric, orders jsonb, total_rows bigint
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
    select r.*, count(*) over ()
    from app.shortage_rows(p_supplier_id, p_category_id, p_only_short) r
    order by r.supplier_name nulls last, r.shortage desc, r.material_code
    limit 2000;
end;
$$;
revoke all on function public.shortages_summary(uuid, uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.shortages_summary(uuid, uuid, boolean) to authenticated;

-- Liczba materiałów z brakiem do zleceń (kafel dashboardu).
create function public.shortage_material_count()
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select app.user_role()) is distinct from 'ADMIN' and (select app.user_role()) is distinct from 'BIURO' then
    raise exception 'Brak uprawnień' using errcode = '42501';
  end if;
  return (select count(*)::integer from app.shortage_rows(null, null, true));
end;
$$;
revoke all on function public.shortage_material_count() from public, anon, authenticated, service_role;
grant execute on function public.shortage_material_count() to authenticated;

-- Braki jednego zlecenia (ADMIN, BIURO): potrzebne / wydano / pozostało / dostępne (wspólne dla wszystkich zleceń!)
-- / brakuje. Wiersze z brakiem pierwsze.
create function public.order_shortages(p_order_id uuid)
returns table (
  material_id uuid, material_code text, material_name text, unit text,
  needed numeric, issued numeric, remaining numeric, available numeric, shortage numeric
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
    select b.material_id, m.code, m.name, m.unit, b.needed, b.issued, b.remaining,
           coalesce(a.available, 0),
           greatest(b.remaining - coalesce(a.available, 0), 0)
    from app.requirement_balance(array[p_order_id]) b
    join public.materials m on m.id = b.material_id
    left join app.shortage_available((select coalesce(array_agg(x.material_id), '{}') from app.requirement_balance(array[p_order_id]) x)) a
      on a.material_id = b.material_id
    order by greatest(b.remaining - coalesce(a.available, 0), 0) desc, m.code;
end;
$$;
revoke all on function public.order_shortages(uuid) from public, anon, authenticated, service_role;
grant execute on function public.order_shortages(uuid) to authenticated;

-- Lista zleceń: liczba list ACTIVE i flaga „są braki” (wzór per zlecenie) dla strony zleceń (ADMIN, BIURO; ≤ 200 id).
create function public.order_overview(p_order_ids uuid[])
returns table (production_order_id uuid, requirement_count integer, has_shortage boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select app.user_role()) is distinct from 'ADMIN' and (select app.user_role()) is distinct from 'BIURO' then
    raise exception 'Brak uprawnień' using errcode = '42501';
  end if;
  if p_order_ids is null or cardinality(p_order_ids) > 200 then
    raise exception 'Zbyt wiele zleceń' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  return query
    with bal as (
      select * from app.requirement_balance(p_order_ids)
    ), avail as (
      select * from app.shortage_available((select coalesce(array_agg(distinct x.material_id), '{}') from bal x))
    )
    select o.id,
           (select count(*)::integer from public.requirements r where r.production_order_id = o.id and r.status = 'ACTIVE'),
           coalesce(bool_or(b.remaining > coalesce(a.available, 0)), false)
    from unnest(p_order_ids) as o(id)
    left join bal b on b.production_order_id = o.id
    left join avail a on a.material_id = b.material_id
    group by o.id;
end;
$$;
revoke all on function public.order_overview(uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.order_overview(uuid[]) to authenticated;

-- Terminal: „Do wydania na to zlecenie” (pozostało > 0) — dla każdej roli z dostępem do magazynu.
create function public.order_to_issue(p_order_id uuid)
returns table (
  material_id uuid, material_code text, material_name text, unit text, allows_fraction boolean,
  remaining numeric, available numeric
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
    select b.material_id, m.code, m.name, m.unit, m.allows_fraction, b.remaining, coalesce(a.available, 0)
    from app.requirement_balance(array[p_order_id]) b
    join public.materials m on m.id = b.material_id
    left join app.shortage_available((select coalesce(array_agg(x.material_id), '{}') from app.requirement_balance(array[p_order_id]) x)) a
      on a.material_id = b.material_id
    where b.remaining > 0
    order by m.code;
end;
$$;
revoke all on function public.order_to_issue(uuid) from public, anon, authenticated, service_role;
grant execute on function public.order_to_issue(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Eksport braków do CSV (ADMIN, BIURO) — format jak export_stock_csv (średnik, przecinek dziesiętny, BOM
-- dokleja route handler, neutralizacja formuł, kody ="KOD"). Sortowanie: dostawca, brak malejąco, kod.
-- ---------------------------------------------------------------------------
create function public.export_shortages_csv(
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
           )),
           E'\r\n' order by r.supplier_name nulls last, r.shortage desc, r.material_code)
  into v_count, v_body
  from (
    select * from app.shortage_rows(p_supplier_id, p_category_id, p_only_short) s
    order by s.supplier_name nulls last, s.shortage desc, s.material_code
    limit c_limit + 1
  ) r;

  if v_count > c_limit then
    raise exception 'Zbyt wiele wierszy do eksportu (maks. %) — zawęź filtry', c_limit
      using errcode = 'P0001', hint = 'TOO_MANY_ROWS';
  end if;
  return 'Dostawca;Kod materiału;Nazwa materiału;Kategoria;Jednostka;Pozostało do wydania;Dostępne;Brakuje;Zlecenia'
    || E'\r\n' || case when v_body is null then '' else v_body || E'\r\n' end;
end;
$$;
revoke all on function public.export_shortages_csv(uuid, uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.export_shortages_csv(uuid, uuid, boolean) to authenticated;
