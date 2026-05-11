-- Evolucion MVP: pausa/reanudar/reiniciar sesiones + reset financiero + reporte mensual.
-- Requiere que `paused` ya exista en `public.session_status`
-- (ver `0003_add_paused_session_status.sql`).

alter table public.sessions
  add column if not exists paused_at timestamptz;

drop index if exists idx_sessions_one_active_per_atv;
drop index if exists idx_sessions_one_open_per_atv;
create unique index if not exists idx_sessions_one_open_per_atv
  on public.sessions(atv_id)
  where status in ('active', 'paused');

create or replace function public.start_session(
  p_atv_id uuid,
  p_duration_minutes integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_atv public.atvs%rowtype;
  v_duration integer;
  v_session_id uuid;
  v_now timestamptz := timezone('utc', clock_timestamp());
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  if p_duration_minutes is null or p_duration_minutes <= 0 then
    raise exception 'La duracion debe ser mayor que cero';
  end if;

  select * into v_atv
  from public.atvs
  where id = p_atv_id and active = true;

  if not found then
    raise exception 'La cuatrimoto no existe o esta inactiva';
  end if;

  if exists (
    select 1
    from public.sessions
    where atv_id = p_atv_id and status in ('active', 'paused')
  ) then
    raise exception 'La cuatrimoto ya tiene una sesion abierta';
  end if;

  v_duration := greatest(1, p_duration_minutes);

  insert into public.sessions (
    atv_id,
    started_by,
    started_at,
    target_end_at,
    paused_at,
    status
  )
  values (
    p_atv_id,
    auth.uid(),
    v_now,
    v_now + make_interval(mins => v_duration),
    null,
    'active'
  )
  returning id into v_session_id;

  return v_session_id;
end;
$$;

create or replace function public.stop_session(
  p_session_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.sessions%rowtype;
  v_atv public.atvs%rowtype;
  v_now timestamptz := timezone('utc', clock_timestamp());
  v_effective_end timestamptz;
  v_minutes integer;
  v_amount integer;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  select * into v_session
  from public.sessions
  where id = p_session_id;

  if not found then
    raise exception 'Sesion no encontrada';
  end if;

  if v_session.status in ('completed', 'cancelled') then
    return v_session.id;
  end if;

  select * into v_atv
  from public.atvs
  where id = v_session.atv_id;

  if v_session.status = 'paused' then
    v_effective_end := coalesce(v_session.paused_at, v_now);
  else
    v_effective_end := v_now;
  end if;

  v_minutes := ceil(extract(epoch from (v_effective_end - v_session.started_at)) / 60.0)::integer;
  v_amount := public.calculate_amount_cop(v_atv.base_minutes, v_atv.base_price_cop, v_minutes);

  update public.sessions
  set
    status = 'completed',
    ended_at = v_effective_end,
    paused_at = null,
    minutes_billed = v_minutes,
    amount_cop = v_amount,
    updated_at = v_now
  where id = v_session.id;

  return v_session.id;
end;
$$;

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
    raise exception 'Los minutos extra deben ser mayores que cero';
  end if;

  select * into v_session
  from public.sessions
  where id = p_session_id;

  if not found then
    raise exception 'Sesion no encontrada';
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

create or replace function public.pause_session(
  p_session_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.sessions%rowtype;
  v_now timestamptz := timezone('utc', clock_timestamp());
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  select * into v_session
  from public.sessions
  where id = p_session_id;

  if not found then
    raise exception 'Sesion no encontrada';
  end if;

  if v_session.status = 'paused' then
    return v_session.id;
  end if;

  if v_session.status <> 'active' then
    raise exception 'Solo una sesion activa se puede pausar';
  end if;

  update public.sessions
  set
    status = 'paused',
    paused_at = v_now,
    updated_at = v_now
  where id = v_session.id;

  return v_session.id;
end;
$$;

create or replace function public.resume_session(
  p_session_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.sessions%rowtype;
  v_now timestamptz := timezone('utc', clock_timestamp());
  v_pause_interval interval;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  select * into v_session
  from public.sessions
  where id = p_session_id;

  if not found then
    raise exception 'Sesion no encontrada';
  end if;

  if v_session.status = 'active' then
    return v_session.id;
  end if;

  if v_session.status <> 'paused' then
    raise exception 'Solo una sesion pausada se puede reanudar';
  end if;

  v_pause_interval := greatest(v_now - coalesce(v_session.paused_at, v_now), interval '0 seconds');

  update public.sessions
  set
    status = 'active',
    paused_at = null,
    target_end_at = target_end_at + v_pause_interval,
    updated_at = v_now
  where id = v_session.id;

  return v_session.id;
end;
$$;

create or replace function public.restart_session(
  p_session_id uuid,
  p_duration_minutes integer default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.sessions%rowtype;
  v_atv public.atvs%rowtype;
  v_now timestamptz := timezone('utc', clock_timestamp());
  v_duration integer;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  select * into v_session
  from public.sessions
  where id = p_session_id;

  if not found then
    raise exception 'Sesion no encontrada';
  end if;

  if v_session.status not in ('active', 'paused') then
    raise exception 'Solo una sesion abierta se puede reiniciar';
  end if;

  select * into v_atv
  from public.atvs
  where id = v_session.atv_id;

  if not found then
    raise exception 'Cuatrimoto no encontrada';
  end if;

  v_duration := greatest(1, coalesce(p_duration_minutes, v_atv.base_minutes));

  update public.sessions
  set
    status = 'active',
    started_at = v_now,
    target_end_at = v_now + make_interval(mins => v_duration),
    paused_at = null,
    ended_at = null,
    minutes_billed = null,
    amount_cop = null,
    updated_at = v_now
  where id = v_session.id;

  return v_session.id;
end;
$$;

create or replace function public.reset_finance_data()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  if not public.is_admin() then
    raise exception 'Solo admin puede reiniciar finanzas';
  end if;

  delete from public.sessions
  where status in ('completed', 'cancelled');

  get diagnostics v_deleted_count = row_count;
  return v_deleted_count;
end;
$$;

grant execute on function public.pause_session(uuid) to authenticated;
grant execute on function public.resume_session(uuid) to authenticated;
grant execute on function public.restart_session(uuid, integer) to authenticated;
grant execute on function public.reset_finance_data() to authenticated;
