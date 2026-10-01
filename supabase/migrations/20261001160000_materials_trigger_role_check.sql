-- Poprawka po review Etapu 2: trigger materials_before_write (BEFORE, SECURITY DEFINER) uruchamia się
-- przed sprawdzeniem RLS WITH CHECK, więc użytkownik bez uprawnień zakładałby blokadę FOR SHARE
-- na wierszach kategorii/dostawcy, zanim RLS odrzuci zapis. Teraz wywołujący z rolą `authenticated`,
-- który nie jest ADMIN-em, dostaje 42501 na samym początku (bez żadnych blokad).
-- `current_setting('role')` zwraca rolę sesji także wewnątrz funkcji SECURITY DEFINER
-- (current_user byłby tu właścicielem funkcji). service_role (sprzątanie testów) nie jest dotknięty.

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

  new.code := upper(btrim(new.code));
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
