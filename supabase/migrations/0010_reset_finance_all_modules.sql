-- Reset financiero global:
-- - Motos: sesiones cerradas/canceladas
-- - Brinca: sesiones cerradas/canceladas
-- - Combos: combos cerrados/cancelados (historial financiero asociado)

create or replace function public.reset_finance_data()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted_sessions integer := 0;
  v_deleted_brinca integer := 0;
  v_deleted_combos integer := 0;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  if not public.is_admin() then
    raise exception 'Solo admin puede reiniciar finanzas';
  end if;

  -- Primero combos historicos para evitar dejar huellas en tablero de combos.
  delete from public.combos
  where status in ('completed', 'cancelled');
  get diagnostics v_deleted_combos = row_count;

  -- Luego historial de Brinca y Moto (cobros cerrados).
  delete from public.brinca_sessions
  where status in ('completed', 'cancelled');
  get diagnostics v_deleted_brinca = row_count;

  delete from public.sessions
  where status in ('completed', 'cancelled');
  get diagnostics v_deleted_sessions = row_count;

  return v_deleted_sessions + v_deleted_brinca + v_deleted_combos;
end;
$$;

grant execute on function public.reset_finance_data() to authenticated;
