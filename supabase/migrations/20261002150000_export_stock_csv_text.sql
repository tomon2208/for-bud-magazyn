-- Poprawki po review Etapu 7 (H1, M1): eksport CSV generowany w SQL (jeden string do Workera, zero JSON.parse
-- i pętli po wierszach w Workerze — budżet CPU ~10 ms na free tier). Zastępuje export_stock_rows (jsonb),
-- która nie jest już używana. Migracja addytywna poza usunięciem tej jednej funkcji odczytu.
-- BOM dokleja route handler. Format: separator ';', CRLF, przecinek dziesiętny bez separatora tysięcy,
-- pola z ; " CR LF w cudzysłowie z podwajaniem ", neutralizacja CSV injection (prefiks '), TAK/NIE.

drop function public.export_stock_rows(text, text, uuid, boolean);

-- Tekst: neutralizacja formuł (= + - @ tab CR → prefiks '), potem cytowanie wg RFC 4180.
create function app.csv_text(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_value is null then ''
    else (
      select case
        when v ~ '[;"\r\n]' then '"' || replace(v, '"', '""') || '"'
        else v
      end
      from (select case when p_value ~ '^[=+@\t\r-]' then '''' || p_value else p_value end as v) s
    )
  end
$$;

-- Liczba: przecinek dziesiętny, bez zer końcowych i bez separatora tysięcy; ujemne bez prefiksu (to liczba, nie tekst).
create function app.csv_num(p_value numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_value is null then '' else replace(trim_scale(p_value)::text, '.', ',') end
$$;

-- Kod (materiał, lokalizacja): Excel zamieniłby kody wyglądające na liczbę/datę/notację naukową ("0518" → 518,
-- "12-03" → data, "1/2", "12.05", "1E5"). Takie kody emitujemy jako ="KOD" — WYŁĄCZNIE gdy kod składa się
-- z bezpiecznych znaków [A-Z0-9._/ -] (formuła nie może zawierać nic poza literałem). Pozostałe kody → csv_text.
create function app.csv_code(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_value is null then ''
    when p_value ~ '^[A-Z0-9._/ -]+$'
         and (p_value ~ '^[-.]?[0-9][0-9 ._/-]*$' or p_value ~ '^[0-9]+E-?[0-9]+$')
      then '"=""' || p_value || '"""'
    else app.csv_text(p_value)
  end
$$;

revoke all on function app.csv_text(text), app.csv_num(numeric), app.csv_code(text) from public, anon;
grant execute on function app.csv_text(text), app.csv_num(numeric), app.csv_code(text) to authenticated;

-- Wariant 'location' (materiał × lokalizacja, stan > 0) albo 'material' (suma per materiał). Zwraca treść BEZ BOM.
-- Limit 20 000 wierszy → P0001 / TOO_MANY_ROWS (API: 400 „zawęź filtry”).
create function public.export_stock_csv(
  p_variant text,
  p_q text default null,
  p_category_id uuid default null,
  p_below_min boolean default false
)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  c_limit constant integer := 20000;
  v_pattern text;
  v_count integer;
  v_body text;
  v_header text;
begin
  if (select app.user_role()) is distinct from 'ADMIN' and (select app.user_role()) is distinct from 'BIURO' then
    raise exception 'Brak uprawnień' using errcode = '42501';
  end if;
  if p_variant not in ('location', 'material') then
    raise exception 'Nieprawidłowy wariant eksportu' using errcode = 'P0001', hint = 'VALIDATION';
  end if;
  if nullif(btrim(p_q), '') is not null then
    v_pattern := '%' || replace(replace(replace(btrim(p_q), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  if p_variant = 'location' then
    v_header := 'Kod materiału;Nazwa materiału;Kategoria;Jednostka;Lokalizacja;Nazwa lokalizacji;Ilość';
    select count(*),
           string_agg(
             app.csv_code(r.material_code) || ';' || app.csv_text(r.material_name) || ';' ||
             app.csv_text(r.category_name) || ';' || app.csv_text(r.unit) || ';' ||
             app.csv_code(r.location_code) || ';' || app.csv_text(r.location_name) || ';' ||
             app.csv_num(r.quantity),
             E'\r\n' order by r.material_code, r.location_code)
    into v_count, v_body
    from (
      select v.material_code, v.material_name, c.name as category_name, v.unit,
             v.location_code, v.location_name, v.quantity
      from public.v_stock v
      join public.material_categories c on c.id = v.category_id
      where v.quantity > 0
        and (p_category_id is null or v.category_id = p_category_id)
        and (not coalesce(p_below_min, false) or v.below_minimum)
        and (v_pattern is null
             or v.material_code ilike v_pattern
             or v.material_name ilike v_pattern
             or v.location_code ilike v_pattern)
      order by v.material_code, v.location_code
      limit c_limit + 1
    ) r;
  else
    v_header := 'Kod materiału;Nazwa materiału;Kategoria;Jednostka;Stan łączny;Stan minimalny;Brakuje do minimum;'
                || 'Poniżej minimum;Liczba lokalizacji;Domyślny dostawca';
    select count(*),
           string_agg(
             app.csv_code(r.material_code) || ';' || app.csv_text(r.material_name) || ';' ||
             app.csv_text(r.category_name) || ';' || app.csv_text(r.unit) || ';' ||
             app.csv_num(r.total_quantity) || ';' || app.csv_num(r.min_quantity) || ';' ||
             app.csv_num(r.shortage) || ';' || case when r.below_minimum then 'TAK' else 'NIE' end || ';' ||
             r.location_count::text || ';' || app.csv_text(r.default_supplier_name),
             E'\r\n' order by r.material_code)
    into v_count, v_body
    from (
      select v.material_code, v.material_name, v.category_name, v.unit,
             v.total_quantity, v.min_quantity, v.shortage, v.below_minimum,
             v.location_count, v.default_supplier_name
      from public.v_material_stock v
      where v.in_view
        and (p_category_id is null or v.category_id = p_category_id)
        and (not coalesce(p_below_min, false) or v.below_minimum)
        and (v_pattern is null or v.material_code ilike v_pattern or v.material_name ilike v_pattern)
      order by v.material_code
      limit c_limit + 1
    ) r;
  end if;

  if v_count > c_limit then
    raise exception 'Zbyt wiele wierszy do eksportu (maks. %) — zawęź filtry', c_limit
      using errcode = 'P0001', hint = 'TOO_MANY_ROWS';
  end if;
  return v_header || E'\r\n' || case when v_body is null then '' else v_body || E'\r\n' end;
end;
$$;

revoke all on function public.export_stock_csv(text, text, uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.export_stock_csv(text, text, uuid, boolean) to authenticated;
