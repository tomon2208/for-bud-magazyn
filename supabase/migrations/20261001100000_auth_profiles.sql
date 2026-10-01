-- Etap 1: role i profile użytkowników.
-- Źródło prawdy o roli i aktywności: public.profiles (nie claim w JWT),
-- dzięki czemu dezaktywacja konta działa natychmiast.
-- "Auto expose new tables" jest wyłączone — uprawnienia nadajemy jawnie.

-- ---------------------------------------------------------------------------
-- Typy
-- ---------------------------------------------------------------------------
create type public.app_role as enum ('ADMIN', 'BIURO', 'PRODUKCJA');

-- ---------------------------------------------------------------------------
-- Prywatny schemat na funkcje pomocnicze (NIE wystawiany w Data API)
-- ---------------------------------------------------------------------------
create schema if not exists app;
revoke all on schema app from public;

-- ---------------------------------------------------------------------------
-- Tabela profiles
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  login text not null unique
    constraint profiles_login_format check (login ~ '^[a-z0-9._-]{3,32}$'),
  full_name text not null
    constraint profiles_full_name_not_blank check (length(btrim(full_name)) between 1 and 120),
  role public.app_role not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'Profil użytkownika (1:1 z auth.users). Rola i aktywność — źródło prawdy dla autoryzacji.';

alter table public.profiles enable row level security;

revoke all on table public.profiles from public, anon, authenticated;
grant select on table public.profiles to authenticated;
-- Klucz secret (service_role) — operacje admina wykonywane wyłącznie przez serwer.
grant select, insert, update, delete on table public.profiles to service_role;

-- ---------------------------------------------------------------------------
-- app.current_role(): rola AKTYWNEGO zalogowanego użytkownika albo NULL
-- ---------------------------------------------------------------------------
create function app.current_role()
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

revoke all on function app.current_role() from public, anon;
grant usage on schema app to authenticated;
grant execute on function app.current_role() to authenticated;

-- ---------------------------------------------------------------------------
-- RLS: tylko odczyt. Brak polityk INSERT/UPDATE/DELETE — zmiany robi serwer kluczem secret.
-- ---------------------------------------------------------------------------
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

create policy profiles_select_admin on public.profiles
  for select to authenticated
  using ((select app.current_role()) = 'ADMIN');

-- ---------------------------------------------------------------------------
-- updated_at + niezmienność id/login
-- ---------------------------------------------------------------------------
create function app.profiles_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id <> old.id then
    raise exception 'Nie można zmienić identyfikatora profilu' using errcode = 'check_violation';
  end if;
  if new.login <> old.login then
    raise exception 'Nie można zmienić loginu' using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function app.profiles_before_update() from public, anon, authenticated;

create trigger profiles_before_update
  before update on public.profiles
  for each row execute function app.profiles_before_update();

-- ---------------------------------------------------------------------------
-- Ochrona ostatniego aktywnego ADMIN-a (UPDATE i DELETE, także kaskadowy z auth.users).
-- Blokada advisory serializuje wszystkie zmiany odbierające uprawnienia ADMIN,
-- a zapytanie liczące wykonuje się po uzyskaniu blokady (nowy snapshot w READ COMMITTED),
-- więc dwie równoległe degradacje dwóch ostatnich adminów nie przejdą obie.
-- ---------------------------------------------------------------------------
create function app.profiles_protect_last_admin()
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

revoke all on function app.profiles_protect_last_admin() from public, anon, authenticated;

create trigger profiles_protect_last_admin
  before update or delete on public.profiles
  for each row execute function app.profiles_protect_last_admin();

-- ---------------------------------------------------------------------------
-- Tworzenie profilu przy zakładaniu konta w Supabase Auth.
-- Dane pochodzą z raw_app_meta_data (ustawiane tylko kluczem secret, użytkownik nie może ich zmienić).
-- Trigger jest odroczony (DEFERRABLE INITIALLY DEFERRED) — działa przy COMMIT transakcji
-- tworzącej konto i czyta aktualny wiersz, więc nie zależy od tego, czy Auth zapisuje
-- app_metadata w INSERT, czy w kolejnym UPDATE tej samej transakcji.
-- Niepoprawne metadane → wyjątek → konto nie powstaje.
-- ---------------------------------------------------------------------------
create function app.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  meta jsonb;
  v_email text;
  v_login text;
  v_full_name text;
  v_role text;
begin
  select u.raw_app_meta_data, u.email into meta, v_email
  from auth.users u
  where u.id = new.id;

  if not found then
    -- Konto usunięte w tej samej transakcji — nic do zrobienia.
    return null;
  end if;

  if exists (select 1 from public.profiles p where p.id = new.id) then
    return null;
  end if;

  v_login := meta ->> 'login';
  v_full_name := btrim(coalesce(meta ->> 'full_name', ''));
  v_role := meta ->> 'role';

  if v_login is null or v_login !~ '^[a-z0-9._-]{3,32}$' then
    raise exception 'Nieprawidłowy login w metadanych konta' using errcode = 'check_violation';
  end if;
  if v_email is distinct from v_login || '@forbud.local' then
    raise exception 'E-mail konta nie odpowiada loginowi' using errcode = 'check_violation';
  end if;
  if v_full_name = '' then
    raise exception 'Brak imienia i nazwiska w metadanych konta' using errcode = 'check_violation';
  end if;
  if v_role is null or v_role not in ('ADMIN', 'BIURO', 'PRODUKCJA') then
    raise exception 'Nieprawidłowa rola w metadanych konta' using errcode = 'check_violation';
  end if;

  insert into public.profiles (id, login, full_name, role)
  values (new.id, v_login, v_full_name, v_role::public.app_role);

  return null;
end;
$$;

revoke all on function app.handle_new_auth_user() from public, anon, authenticated;

create constraint trigger on_auth_user_created
  after insert on auth.users
  deferrable initially deferred
  for each row execute function app.handle_new_auth_user();
