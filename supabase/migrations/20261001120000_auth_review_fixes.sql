-- Poprawki po review Etapu 1:
-- 1) app.current_role() → app.user_role() (nazwa "current_role" koliduje ze słowem kluczowym SQL),
-- 2) ochrona ostatniego ADMIN-a odporna na poziom izolacji,
-- 3) public.revoke_user_sessions(uuid) — unieważnienie sesji przy dezaktywacji konta.

-- ---------------------------------------------------------------------------
-- 1. app.user_role()
-- ---------------------------------------------------------------------------
create function app.user_role()
returns public.app_role
language sql
stable
security definer
set search_path = ''
as $$
  select p.role
  from public.profiles p
  where p.id = auth.uid()
    and p.active
$$;

revoke all on function app.user_role() from public, anon;
grant execute on function app.user_role() to authenticated;

drop policy profiles_select_admin on public.profiles;
create policy profiles_select_admin on public.profiles
  for select to authenticated
  using ((select app.user_role()) = 'ADMIN');

drop function app.current_role();

-- ---------------------------------------------------------------------------
-- 2. Ochrona ostatniego aktywnego ADMIN-a.
-- Poprawność opiera się na: blokadzie advisory (serializuje wszystkie zmiany odbierające
-- uprawnienia ADMIN) + READ COMMITTED (zapytanie liczące po uzyskaniu blokady widzi nowy snapshot,
-- czyli zatwierdzone zmiany równoległej transakcji). W REPEATABLE READ snapshot jest zamrożony
-- na początku transakcji i ochrona mogłaby przepuścić wyścig — dlatego taką zmianę odrzucamy.
-- (SERIALIZABLE jest bezpieczne dzięki SSI.) FOR UPDATE na wierszach innych adminów celowo
-- nie jest użyte: razem z blokadą wiersza z UPDATE prowadziłoby do zakleszczeń w wyścigu.
-- ---------------------------------------------------------------------------
create or replace function app.profiles_protect_last_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  remaining integer;
begin
  -- Interesuje nas tylko sytuacja, w której aktywny ADMIN przestaje nim być.
  if not (old.role = 'ADMIN' and old.active) then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and new.role = 'ADMIN' and new.active then
    return new;
  end if;

  if current_setting('transaction_isolation') = 'repeatable read' then
    raise exception 'Odebranie uprawnień ADMIN wymaga poziomu izolacji READ COMMITTED lub SERIALIZABLE'
      using errcode = 'P0001', hint = 'ISOLATION';
  end if;

  perform pg_advisory_xact_lock(hashtext('forbud.profiles.last_admin'));

  select count(*) into remaining
  from public.profiles p
  where p.role = 'ADMIN'
    and p.active
    and p.id <> old.id;

  if remaining = 0 then
    raise exception 'Nie można odebrać uprawnień ostatniemu aktywnemu administratorowi'
      using errcode = 'P0001', hint = 'LAST_ADMIN';
  end if;

  return coalesce(new, old);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Unieważnienie wszystkich sesji użytkownika (refresh tokeny usuwane kaskadowo).
-- Wywoływane przez serwer (klucz secret) przy dezaktywacji konta.
-- ---------------------------------------------------------------------------
create function public.revoke_user_sessions(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted integer;
begin
  delete from auth.sessions s where s.user_id = p_user_id;
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

revoke all on function public.revoke_user_sessions(uuid) from public, anon, authenticated;
grant execute on function public.revoke_user_sessions(uuid) to service_role;
