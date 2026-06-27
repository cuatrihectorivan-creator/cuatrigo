-- Blindaje de tiempo en backend:
-- 1) Nunca cobrar por encima de target_end_at en cierre manual (stop_*).
-- 2) Cierre defensivo al iniciar nuevas sesiones, por si el cron se retrasa.

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
    raise exception 'No autenticado';git
  end if;

  if p_duration_minutes is null or p_duration_minutes <= 0 then
    raise exception 'La duracion debe ser mayor que cero';
  end if;

  -- Auto-heal: si existe una sesion vencida que no cerro por cron, se cierra antes de validar disponibilidad.
  perform public.refresh_expired_sessions();

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

create or replace function public.start_brinca_session(
  p_child_name text,
  p_duration_minutes integer default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings public.brinca_settings%rowtype;
  v_duration integer;
  v_session_id uuid;
  v_now timestamptz := timezone('utc', clock_timestamp());
  v_child_name text;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  v_child_name := trim(coalesce(p_child_name, ''));
  if length(v_child_name) = 0 then
    raise exception 'Debes ingresar el nombre del nino';
  end if;

  select * into v_settings
  from public.brinca_settings
  where id = true;

  if not found then
    raise exception 'Configuracion de Brinca no encontrada';
  end if;

  -- Auto-heal: cierra vencidas pendientes antes de abrir una nueva sesion.
  perform public.refresh_expired_brinca_sessions();

  v_duration := greatest(1, coalesce(p_duration_minutes, v_settings.base_minutes));

  insert into public.brinca_sessions (
    child_name,
    started_by,
    started_at,
    target_end_at,
    paused_at,
    status,
    base_minutes,
    base_price_cop
  )
  values (
    v_child_name,
    auth.uid(),
    v_now,
    v_now + make_interval(mins => v_duration),
    null,
    'active',
    v_settings.base_minutes,
    v_settings.base_price_cop
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
  v_minutes_used integer;
  v_minutes_billed integer;
  v_amount integer;
  v_is_combo boolean := false;
  v_base_minutes integer;
  v_base_price_cop integer;
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

  select exists (
    select 1
    from public.combos c
    where c.moto_session_id = v_session.id
      and c.status <> 'cancelled'
  )
  into v_is_combo;

  if v_is_combo then
    v_base_minutes := 10;
    v_base_price_cop := 8000;
  else
    v_base_minutes := v_atv.base_minutes;
    v_base_price_cop := v_atv.base_price_cop;
  end if;

  if v_session.status = 'paused' then
    v_effective_end := coalesce(v_session.paused_at, v_now);
  else
    v_effective_end := v_now;
  end if;

  -- Tope duro para nunca sobrepasar el tiempo contratado.
  v_effective_end := greatest(v_session.started_at, least(v_effective_end, v_session.target_end_at));

  v_minutes_used := ceil(extract(epoch from (v_effective_end - v_session.started_at)) / 60.0)::integer;
  v_minutes_billed := public.calculate_billed_minutes(v_base_minutes, v_minutes_used);
  v_amount := public.calculate_amount_cop(v_base_minutes, v_base_price_cop, v_minutes_used);

  update public.sessions
  set
    status = 'completed',
    ended_at = v_effective_end,
    paused_at = null,
    minutes_billed = v_minutes_billed,
    amount_cop = v_amount,
    updated_at = v_now
  where id = v_session.id;

  return v_session.id;
end;
$$;

create or replace function public.stop_brinca_session(
  p_session_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.brinca_sessions%rowtype;
  v_now timestamptz := timezone('utc', clock_timestamp());
  v_effective_end timestamptz;
  v_minutes_used integer;
  v_minutes_billed integer;
  v_amount integer;
  v_is_combo boolean := false;
  v_base_minutes integer;
  v_base_price_cop integer;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  select * into v_session
  from public.brinca_sessions
  where id = p_session_id;

  if not found then
    raise exception 'Sesion de Brinca no encontrada';
  end if;

  if v_session.status in ('completed', 'cancelled') then
    return v_session.id;
  end if;

  select exists (
    select 1
    from public.combos c
    where c.brinca_session_id = v_session.id
      and c.status <> 'cancelled'
  )
  into v_is_combo;

  if v_is_combo then
    v_base_minutes := 15;
    v_base_price_cop := 5000;
  else
    v_base_minutes := v_session.base_minutes;
    v_base_price_cop := v_session.base_price_cop;
  end if;

  if v_session.status = 'paused' then
    v_effective_end := coalesce(v_session.paused_at, v_now);
  else
    v_effective_end := v_now;
  end if;

  -- Tope duro para nunca sobrepasar el tiempo contratado.
  v_effective_end := greatest(v_session.started_at, least(v_effective_end, v_session.target_end_at));

  v_minutes_used := ceil(extract(epoch from (v_effective_end - v_session.started_at)) / 60.0)::integer;
  v_minutes_billed := public.calculate_billed_minutes(v_base_minutes, v_minutes_used);
  v_amount := public.calculate_amount_cop(v_base_minutes, v_base_price_cop, v_minutes_used);

  update public.brinca_sessions
  set
    status = 'completed',
    ended_at = v_effective_end,
    paused_at = null,
    minutes_billed = v_minutes_billed,
    amount_cop = v_amount,
    updated_at = v_now
  where id = v_session.id;

  return v_session.id;
end;
$$;
