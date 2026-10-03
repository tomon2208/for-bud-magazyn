-- Etap 12a: import zapotrzebowania z LiczOkno (ADR 016). Migracja addytywna:
--  * materials.bar_length_m — długość sztangi [m] (przeliczanie metrów z pliku na sztangi),
--  * import_code_aliases — powiązania „kod z pliku → materiał” (MAP) i lista „nie magazynujemy” (IGNORE),
--  * resolve_import_codes — dopasowanie kodów z pliku do kartoteki w jednym round-tripie,
--  * wspólny rdzeń app.create_requirement_core (create_requirement zachowuje sygnaturę i zachowanie)
--    + import_requirement (lista IMPORT do istniejącego zlecenia albo nowe zlecenie + lista ATOMOWO).
-- Parsowanie pliku odbywa się w przeglądarce — do bazy trafia wyłącznie znormalizowany JSON.

-- ---------------------------------------------------------------------------
-- 1. Kartoteka: długość sztangi
-- ---------------------------------------------------------------------------
alter table public.materials
  add column bar_length_m numeric(6, 3)
    constraint materials_bar_length_valid check (bar_length_m is null or (bar_length_m > 0 and bar_length_m <= 20));

comment on column public.materials.bar_length_m is
  'Długość sztangi [m] (opcjonalna) — przy imporcie LiczOkno metry z pliku są przeliczane na sztangi: ceil(suma m / długość).';

-- ---------------------------------------------------------------------------
-- 2. Normalizacja kodu (ta sama co w triggerze materiałów)
-- ---------------------------------------------------------------------------
create function app.normalize_material_code(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select upper(btrim(regexp_replace(p_code, '\s+', ' ', 'g')))
$$;
revoke all on function app.normalize_material_code(text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. import_code_aliases
-- ---------------------------------------------------------------------------
-- MAP: kod z pliku → wskazany materiał (jawna decyzja użytkownika, ma pierwszeństwo przed dopasowaniem po kodzie).
-- IGNORE: lista „nie magazynujemy” — kod jest pomijany w kolejnych importach.
-- To konfiguracja, nie historia — wiersze można usuwać. Zapis wyłącznie funkcjami (BIURO, ADMIN).
create table public.import_code_aliases (
  id uuid primary key default gen_random_uuid(),
  source_code text not null
    constraint import_code_aliases_code_valid
    check (source_code ~ '^[A-Z0-9._/-]+( [A-Z0-9._/-]+)*$' and length(source_code) between 1 and 50),
  action text not null
    constraint import_code_aliases_action_valid check (action in ('MAP', 'IGNORE')),
  -- Powiązanie traci sens po usunięciu materiału (materiały nie są usuwane w aplikacji; kaskada tylko dla sprzątania testów).
  material_id uuid references public.materials (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id),
  updated_by uuid references public.profiles (id),
  constraint import_code_aliases_code_key unique (source_code),
  constraint import_code_aliases_action_material check (
    (action = 'MAP' and material_id is not null) or (action = 'IGNORE' and material_id is null)
  )
);

create index import_code_aliases_material_idx on public.import_code_aliases (material_id) where material_id is not null;

comment on table public.import_code_aliases is
  'Import LiczOkno: powiązania kodów z pliku z materiałami (MAP) i lista „nie magazynujemy” (IGNORE). Konfiguracja, nie historia.';

create trigger import_code_aliases_audit
  before insert or update on public.import_code_aliases
  for each row execute function app.catalog_set_audit();

alter table public.import_code_aliases enable row level security;

-- Role aplikacyjne: tylko SELECT (BIURO, ADMIN; PRODUKCJA nie potrzebuje). Zapis przez funkcje SECURITY DEFINER.
-- service_role: SELECT + DELETE — wyłącznie sprzątanie testów.
revoke all on table public.import_code_aliases from public, anon, authenticated, service_role;
grant select on table public.import_code_aliases to authenticated;
grant select, delete on table public.import_code_aliases to service_role;

create policy import_code_aliases_select on public.import_code_aliases
  for select to authenticated using ((select app.user_role()) in ('ADMIN', 'BIURO'));

-- upsert po source_code (kod normalizowany jak kod materiału).
create function public.upsert_import_alias(p_source_code text, p_action text, p_material_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.app_role := app.user_role();
  v_code text := app.normalize_material_code(p_source_code);
  v_active boolean;
  v_mat_code text;
  v_row public.import_code_aliases%rowtype;
begin
  if auth.uid() is null or v_role is null or v_role not in ('ADMIN', 'BIURO') then
    raise exception 'Brak uprawnień do zarządzania powiązaniami kodów' using errcode = '42501';
  end if;
  if v_code is null or v_code !~ '^[A-Z0-9._/-]+( [A-Z0-9._/-]+)*$' or length(v_code) not between 1 and 50 then
    raise exception 'Kod zawiera niedozwolone znaki albo ma nieprawidłową długość' using errcode = 'P0001', hint = 'INVALID_CODE';
  end if;
  if p_action is null or p_action not in ('MAP', 'IGNORE') then
    raise exception 'Nieprawidłowa akcja' using errcode = 'P0001', hint = 'VALIDATION';
  end if;

  if p_action = 'MAP' then
    if p_material_id is null then
      raise exception 'Wskaż materiał' using errcode = 'P0001', hint = 'VALIDATION';
    end if;
    select m.active, m.code into v_active, v_mat_code from public.materials m where m.id = p_material_id for share;
    if not found then
      raise exception 'Nie znaleziono materiału' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'material';
    end if;
    if not v_active then
      raise exception 'Materiał jest nieaktywny' using errcode = 'P0001', hint = 'MATERIAL_INACTIVE', detail = v_mat_code;
    end if;
  elsif p_material_id is not null then
    raise exception 'Lista „nie magazynujemy” nie przyjmuje materiału' using errcode = 'P0001', hint = 'VALIDATION';
  end if;

  insert into public.import_code_aliases (source_code, action, material_id)
  values (v_code, p_action, p_material_id)
  on conflict (source_code) do update set action = excluded.action, material_id = excluded.material_id
  returning * into v_row;

  return jsonb_build_object('id', v_row.id, 'source_code', v_row.source_code, 'action', v_row.action, 'material_id', v_row.material_id);
end;
$$;
revoke all on function public.upsert_import_alias(text, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.upsert_import_alias(text, text, uuid) to authenticated;

create function public.delete_import_alias(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.app_role := app.user_role();
begin
  if auth.uid() is null or v_role is null or v_role not in ('ADMIN', 'BIURO') then
    raise exception 'Brak uprawnień do zarządzania powiązaniami kodów' using errcode = '42501';
  end if;
  delete from public.import_code_aliases a where a.id = p_id;
  if not found then
    raise exception 'Nie znaleziono powiązania' using errcode = 'P0001', hint = 'NOT_FOUND', detail = 'alias';
  end if;
end;
$$;
revoke all on function public.delete_import_alias(uuid) from public, anon, authenticated, service_role;
grant execute on function public.delete_import_alias(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. resolve_import_codes: kod z pliku → powiązanie / materiał / nieznany (jeden round-trip)
-- ---------------------------------------------------------------------------
-- Kolejność: powiązanie (jawna decyzja użytkownika) → dokładny kod materiału → nieznany.
-- Zwraca po jednym wierszu na DISTINCT kod po normalizacji (trim, białe znaki → spacja, UPPERCASE).
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
  active boolean
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
    )
    select i.code,
           case
             when a.action = 'IGNORE' then 'IGNORED'
             when a.action = 'MAP' then 'ALIAS_MAP'
             when m2.id is not null then 'MATERIAL'
             else 'UNKNOWN'
           end,
           a.id,
           case when a.action = 'MAP' then m1.id else m2.id end,
           case when a.action = 'MAP' then m1.code else m2.code end,
           case when a.action = 'MAP' then m1.name else m2.name end,
           case when a.action = 'MAP' then m1.unit else m2.unit end,
           case when a.action = 'MAP' then m1.allows_fraction else m2.allows_fraction end,
           case when a.action = 'MAP' then m1.bar_length_m else m2.bar_length_m end,
           case when a.action = 'MAP' then m1.active else m2.active end
    from input i
    left join public.import_code_aliases a on a.source_code = i.code
    left join public.materials m1 on m1.id = a.material_id
    left join public.materials m2 on m2.code = i.code
    order by i.code;
end;
$$;
revoke all on function public.resolve_import_codes(text[]) from public, anon, authenticated, service_role;
grant execute on function public.resolve_import_codes(text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Wspólny rdzeń tworzenia listy zapotrzebowania (create_requirement + import_requirement)
-- ---------------------------------------------------------------------------
-- Struktura p_items: tablica 1–500 obiektów.
create function app.requirement_check_shape(p_items jsonb)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 500 then
    raise exception 'Lista musi mieć od 1 do 500 pozycji' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  if exists (select 1 from jsonb_array_elements(p_items) e where jsonb_typeof(e) <> 'object') then
    raise exception 'Nieprawidłowa pozycja listy' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
end;
$$;
revoke all on function app.requirement_check_shape(jsonb) from public, anon, authenticated, service_role;

-- Odcisk żądania (idempotencja). Dla MANUAL — dokładnie wzór z migracji 20261003110000 (powtórzenia sprzed tej
-- migracji nadal się zgadzają); dla IMPORT dodatkowo raw_source_ref pozycji, plik i format. p_scope = id zlecenia
-- albo „NEW:<nazwa>|<numer>” (import z utworzeniem zlecenia).
create function app.requirement_request_hash(
  p_scope text, p_name text, p_items jsonb, p_source text, p_file_name text, p_import_format text
)
returns text
language sql
stable
set search_path = ''
as $$
  select md5(
    coalesce(btrim(p_name), '') || E'\n' || p_scope || E'\n' ||
    coalesce(string_agg(
      coalesce(x.material_id::text, '') || '|' || coalesce(trim_scale(x.quantity)::text, '') || '|' ||
      coalesce(nullif(btrim(x.note), ''), '') ||
      case when p_source = 'IMPORT' then '|' || coalesce(nullif(btrim(x.raw_source_ref), ''), '') else '' end,
      E'\n' order by x.material_id, x.quantity), '') ||
    case when p_source = 'IMPORT' then E'\nIMPORT|' || coalesce(btrim(p_file_name), '') || '|' || coalesce(btrim(p_import_format), '') else '' end
  )
  from jsonb_to_recordset(p_items) as x(material_id uuid, quantity numeric, note text, raw_source_ref text)
$$;
revoke all on function app.requirement_request_hash(text, text, jsonb, text, text, text) from public, anon, authenticated, service_role;

-- Rdzeń: walidacje i zapis listy (rola sprawdzana przez funkcje publiczne). Zachowuje wszystkie reguły
-- create_requirement (1–500 pozycji, DUPLICATE_MATERIAL, INVALID_QUANTITY, NOT_INTEGER, MATERIAL_INACTIVE,
-- ORDER_NOT_OPEN + zlecenie FOR SHARE, idempotencja z request_hash).
create function app.create_requirement_core(
  p_order_id uuid,
  p_scope text,
  p_name text,
  p_items jsonb,
  p_client_request_id uuid,
  p_source text,
  p_file_name text,
  p_import_format text
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
  where not m.active
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
revoke all on function app.create_requirement_core(uuid, text, text, jsonb, uuid, text, text, text) from public, anon, authenticated, service_role;

-- create_requirement: ta sama sygnatura, role i odpowiedź (bez order_id) — cienka nakładka na rdzeń.
create or replace function public.create_requirement(
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
  v_role public.app_role := app.user_role();
begin
  if auth.uid() is null or v_role is null or v_role not in ('ADMIN', 'BIURO') then
    raise exception 'Brak uprawnień do tworzenia zapotrzebowania' using errcode = '42501';
  end if;
  return app.create_requirement_core(p_order_id, p_order_id::text, p_name, p_items, p_client_request_id, 'MANUAL', null, null)
         - 'order_id';
end;
$$;
revoke all on function public.create_requirement(uuid, text, jsonb, uuid) from public, anon, authenticated, service_role;
grant execute on function public.create_requirement(uuid, text, jsonb, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. import_requirement
-- ---------------------------------------------------------------------------
-- Dokładnie jedno z: p_order_id (lista do istniejącego zlecenia) albo p_new_order ({name, number?} — zlecenie i lista
-- powstają ATOMOWO w jednej transakcji; błąd pozycji cofa także zlecenie). p_items: {material_id, quantity, note?,
-- raw_source_ref?}. Idempotencja po p_client_request_id (wymagany): powtórzenie tej samej treści → replay.
-- Zwraca {order_id, requirement_id, item_count, order_created, idempotent_replay}.
-- Po masowym imporcie wykonać ANALYZE requirements, requirement_items (ADR 013) — nie w funkcji.
create function public.import_requirement(
  p_order_id uuid,
  p_new_order jsonb,
  p_name text,
  p_file_name text,
  p_import_format text,
  p_items jsonb,
  p_client_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role public.app_role := app.user_role();
  v_order_id uuid := p_order_id;
  v_scope text;
  v_order_name text;
  v_order_number text;
  v_req public.requirements%rowtype;
  v_hash text;
  v_result jsonb;
begin
  if v_uid is null or v_role is null or v_role not in ('ADMIN', 'BIURO') then
    raise exception 'Brak uprawnień do importu zapotrzebowania' using errcode = '42501';
  end if;
  if p_client_request_id is null then
    raise exception 'Brak identyfikatora żądania' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  if (p_order_id is null) = (p_new_order is null) then
    raise exception 'Podaj zlecenie albo dane nowego zlecenia (dokładnie jedno)' using errcode = 'P0001', hint = 'VALIDATION';
  end if;

  if p_new_order is null then
    v_scope := p_order_id::text;
  else
    -- Typy pól: name — tekst; number — brak / null / tekst (inaczej np. {"name": 5} dałoby zlecenie o nazwie „5”).
    if jsonb_typeof(p_new_order) <> 'object'
       or exists (select 1 from jsonb_object_keys(p_new_order) k where k not in ('name', 'number'))
       or jsonb_typeof(p_new_order -> 'name') is distinct from 'string'
       or coalesce(jsonb_typeof(p_new_order -> 'number'), 'null') not in ('null', 'string') then
      raise exception 'Nieprawidłowe dane nowego zlecenia' using errcode = 'P0001', hint = 'VALIDATION';
    end if;
    v_order_name := btrim(p_new_order ->> 'name');
    v_order_number := nullif(btrim(p_new_order ->> 'number'), '');
    if v_order_name is null or length(v_order_name) not between 1 and 120 or length(v_order_number) > 50 then
      raise exception 'Zlecenie: nazwa 1–120 znaków, numer do 50 znaków' using errcode = 'P0001', hint = 'VALIDATION';
    end if;
    v_scope := 'NEW:' || v_order_name || '|' || coalesce(v_order_number, '');

    -- Replay dla nowego zlecenia: zlecenie już powstało przy pierwszym żądaniu (rdzeń zna tylko id zlecenia).
    perform app.requirement_check_shape(p_items);
    perform pg_advisory_xact_lock(hashtextextended('forbud.requirement:' || p_client_request_id::text, 0));
    select * into v_req from public.requirements r where r.client_request_id = p_client_request_id;
    if found then
      v_hash := app.requirement_request_hash(v_scope, btrim(p_name), p_items, 'IMPORT', btrim(p_file_name), btrim(p_import_format));
      if v_req.created_by is distinct from v_uid or v_req.request_hash is distinct from v_hash then
        raise exception 'Ten identyfikator żądania został już użyty dla innej listy' using errcode = 'P0001', hint = 'IDEMPOTENCY_CONFLICT';
      end if;
      return jsonb_build_object(
        'order_id', v_req.production_order_id,
        'requirement_id', v_req.id,
        'item_count', (select count(*) from public.requirement_items i where i.requirement_id = v_req.id),
        'order_created', true,
        'idempotent_replay', true
      );
    end if;

    begin
      insert into public.production_orders (name, number) values (v_order_name, v_order_number) returning id into v_order_id;
    exception when unique_violation then
      raise exception 'Zlecenie o tym numerze już istnieje' using errcode = 'P0001', hint = 'NUMBER_TAKEN';
    end;
  end if;

  v_result := app.create_requirement_core(
    v_order_id, v_scope, p_name, p_items, p_client_request_id, 'IMPORT', p_file_name, p_import_format);
  return v_result || jsonb_build_object('order_created', p_new_order is not null);
end;
$$;
revoke all on function public.import_requirement(uuid, jsonb, text, text, text, jsonb, uuid) from public, anon, authenticated, service_role;
grant execute on function public.import_requirement(uuid, jsonb, text, text, text, jsonb, uuid) to authenticated;
