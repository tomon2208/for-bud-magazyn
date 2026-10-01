-- Decyzja użytkownika: kod materiału może zawierać pojedyncze spacje wewnątrz (np. 'K518 RAL9016').
-- Normalizacja: białe znaki → jedna spacja, trim, UPPERCASE (trigger) — unikalność nadal bezwzględna
-- wobec wielkości liter i liczby spacji. Format: segmenty [A-Z0-9._/-] rozdzielone pojedynczą spacją, max 50 znaków.
-- Istniejące kody (wielkie litery, bez spacji) spełniają nowy warunek.

alter table public.materials drop constraint materials_code_valid;
alter table public.materials
  add constraint materials_code_valid
  check (code ~ '^[A-Z0-9._/-]+( [A-Z0-9._/-]+)*$' and length(code) between 1 and 50);

create or replace function app.materials_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_active boolean;
begin
  if current_setting('role', true) = 'authenticated'
     and (select app.user_role()) is distinct from 'ADMIN' then
    raise exception 'Brak uprawnień do zapisu materiałów' using errcode = '42501';
  end if;

  new.code := upper(btrim(regexp_replace(new.code, '\s+', ' ', 'g')));
  new.name := btrim(new.name);
  new.unit := btrim(new.unit);
  new.notes := nullif(btrim(new.notes), '');

  if tg_op = 'INSERT' or new.category_id is distinct from old.category_id then
    select c.active into v_active
    from public.material_categories c
    where c.id = new.category_id
    for share;
    if found and not v_active then
      raise exception 'Kategoria jest nieaktywna' using errcode = 'P0001', hint = 'INACTIVE_CATEGORY';
    end if;
  end if;

  if new.default_supplier_id is not null
     and (tg_op = 'INSERT' or new.default_supplier_id is distinct from old.default_supplier_id) then
    select s.active into v_active
    from public.suppliers s
    where s.id = new.default_supplier_id
    for share;
    if found and not v_active then
      raise exception 'Dostawca jest nieaktywny' using errcode = 'P0001', hint = 'INACTIVE_SUPPLIER';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function app.materials_before_write() from public, anon, authenticated;
