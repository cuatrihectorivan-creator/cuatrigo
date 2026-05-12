-- Regla comercial minima:
-- - Moto: nunca cobrar menos de 10000 COP por sesion
-- - Brinca: nunca cobrar menos de 5000 COP por sesion

-- Normaliza tarifas existentes por debajo del minimo.
update public.atvs
set base_price_cop = 10000
where base_price_cop < 10000;

update public.brinca_settings
set base_price_cop = 5000
where base_price_cop < 5000;

update public.brinca_sessions
set base_price_cop = 5000
where base_price_cop < 5000;

-- Refuerza minima de tarifa en tablas.
alter table public.atvs
  drop constraint if exists atvs_base_price_cop_check;
alter table public.atvs
  drop constraint if exists atvs_base_price_min_check;
alter table public.atvs
  add constraint atvs_base_price_min_check check (base_price_cop >= 10000);

alter table public.brinca_settings
  drop constraint if exists brinca_settings_base_price_cop_check;
alter table public.brinca_settings
  drop constraint if exists brinca_settings_base_price_min_check;
alter table public.brinca_settings
  add constraint brinca_settings_base_price_min_check check (base_price_cop >= 5000);

alter table public.brinca_sessions
  drop constraint if exists brinca_sessions_base_price_cop_check;
alter table public.brinca_sessions
  drop constraint if exists brinca_sessions_base_price_min_check;
alter table public.brinca_sessions
  add constraint brinca_sessions_base_price_min_check check (base_price_cop >= 5000);

-- Refuerza validacion de backend para tarifa de Brinca.
create or replace function public.update_brinca_settings(
  p_base_minutes integer,
  p_base_price_cop integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  if not public.is_admin() then
    raise exception 'Solo admin puede editar configuracion de Brinca';
  end if;

  if p_base_minutes is null or p_base_minutes <= 0 then
    raise exception 'Base minutos debe ser mayor que cero';
  end if;

  if p_base_price_cop is null or p_base_price_cop < 5000 then
    raise exception 'Base precio de Brinca debe ser minimo 5000 COP';
  end if;

  insert into public.brinca_settings (id, base_minutes, base_price_cop)
  values (true, p_base_minutes, p_base_price_cop)
  on conflict (id) do update
  set
    base_minutes = excluded.base_minutes,
    base_price_cop = excluded.base_price_cop,
    updated_at = timezone('utc', clock_timestamp());

  return true;
end;
$$;
