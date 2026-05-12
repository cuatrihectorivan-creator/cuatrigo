-- Seguridad de negocio:
-- No permitir extender tiempo (+ minutos) en sesiones que pertenecen a combos.
-- Aplica tanto para Moto como para Brinca a nivel RPC/backend.

create or replace function public.extend_session(
  p_session_id uuid,
  p_extra_minutes integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.sessions%rowtype;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  if p_extra_minutes is null or p_extra_minutes <= 0 then
    raise exception 'Minutos extra debe ser mayor que cero';
  end if;

  select * into v_session
  from public.sessions
  where id = p_session_id;

  if not found then
    raise exception 'Sesion no encontrada';
  end if;

  if exists (
    select 1
    from public.combos c
    where c.moto_session_id = v_session.id
      and c.status <> 'cancelled'
  ) then
    raise exception 'No se puede extender tiempo en una sesion de combo';
  end if;

  if v_session.status not in ('active', 'paused') then
    raise exception 'Solo se puede extender una sesion abierta';
  end if;

  update public.sessions
  set target_end_at = target_end_at + make_interval(mins => p_extra_minutes)
  where id = v_session.id;

  return v_session.id;
end;
$$;

create or replace function public.extend_brinca_session(
  p_session_id uuid,
  p_extra_minutes integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.brinca_sessions%rowtype;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  if p_extra_minutes is null or p_extra_minutes <= 0 then
    raise exception 'Minutos extra debe ser mayor que cero';
  end if;

  select * into v_session
  from public.brinca_sessions
  where id = p_session_id;

  if not found then
    raise exception 'Sesion de Brinca no encontrada';
  end if;

  if exists (
    select 1
    from public.combos c
    where c.brinca_session_id = v_session.id
      and c.status <> 'cancelled'
  ) then
    raise exception 'No se puede extender tiempo en una sesion de combo';
  end if;

  if v_session.status not in ('active', 'paused') then
    raise exception 'Solo se puede extender una sesion abierta';
  end if;

  update public.brinca_sessions
  set target_end_at = target_end_at + make_interval(mins => p_extra_minutes)
  where id = v_session.id;

  return v_session.id;
end;
$$;

grant execute on function public.extend_session(uuid, integer) to authenticated;
grant execute on function public.extend_brinca_session(uuid, integer) to authenticated;
