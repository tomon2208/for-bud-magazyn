-- Poprawka po review Etapu 5 (L4): podsumowanie wydań na zlecenie liczone w SQL (sum + group by) zamiast
-- pobierania wszystkich ruchów do Workera. Migracja addytywna (nowa funkcja, bez zmian danych).
-- SECURITY INVOKER: obowiązuje RLS tabel stockowych (ADMIN/BIURO — wszystkie ruchy; PRODUKCJA — tylko własne).
-- Etap 6: storno/korekta wydania musi zostać uwzględnione w tym podsumowaniu (ADR 010, „Uwagi na Etap 6”).
create function public.order_issue_summary(p_order_id uuid)
returns table (
  material_id uuid,
  material_code text,
  material_name text,
  unit text,
  quantity numeric,
  issues integer
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
    count(*)::integer as issues
  from public.stock_movements mv
  join public.stock_operations o on o.id = mv.operation_id
  join public.materials m on m.id = mv.material_id
  where o.production_order_id = p_order_id
    and o.type = 'ISSUE'
  group by m.id, m.code, m.name, m.unit
  order by m.code
$$;

revoke all on function public.order_issue_summary(uuid) from public, anon, authenticated, service_role;
grant execute on function public.order_issue_summary(uuid) to authenticated;
