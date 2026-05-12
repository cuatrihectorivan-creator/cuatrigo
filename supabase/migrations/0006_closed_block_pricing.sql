-- Regla comercial de cobro por bloques cerrados:
-- - Moto: bloques de base_minutes (ej. 10 min)
-- - Brinca: bloques de base_minutes (ej. 15 min)
-- Siempre se cobra minimo 1 bloque por sesion iniciada.

create or replace function public.calculate_billed_minutes(
  p_base_minutes integer,
  p_used_minutes integer
)
returns integer
language sql
immutable
as $$
  select greatest(1, ceil(greatest(p_used_minutes, 0)::numeric / greatest(p_base_minutes, 1)::numeric)::integer)
    * greatest(p_base_minutes, 1);
$$;

create or replace function public.calculate_amount_cop(
  p_base_minutes integer,
  p_base_price_cop integer,
  p_used_minutes integer
)
returns integer
language sql
immutable
as $$
  select greatest(
    greatest(p_base_price_cop, 1),
    ceil(greatest(p_used_minutes, 0)::numeric / greatest(p_base_minutes, 1)::numeric)::integer * greatest(p_base_price_cop, 1)
  )::integer;
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

  v_minutes_used := ceil(extract(epoch from (v_effective_end - v_session.started_at)) / 60.0)::integer;
  v_minutes_billed := public.calculate_billed_minutes(v_atv.base_minutes, v_minutes_used);
  v_amount := public.calculate_amount_cop(v_atv.base_minutes, v_atv.base_price_cop, v_minutes_used);

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

create or replace function public.refresh_expired_sessions()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := timezone('utc', clock_timestamp());
  v_count integer := 0;
begin
  update public.sessions
  set
    status = 'completed',
    ended_at = greatest(target_end_at, started_at),
    paused_at = null,
    minutes_billed = public.calculate_billed_minutes(
      atvs.base_minutes,
      ceil(extract(epoch from (greatest(target_end_at, started_at) - started_at)) / 60.0)::integer
    ),
    amount_cop = public.calculate_amount_cop(
      atvs.base_minutes,
      atvs.base_price_cop,
      ceil(extract(epoch from (greatest(target_end_at, started_at) - started_at)) / 60.0)::integer
    ),
    updated_at = v_now
  from public.atvs
  where
    public.sessions.atv_id = public.atvs.id
    and public.sessions.status = 'active'
    and public.sessions.target_end_at <= v_now;

  get diagnostics v_count = row_count;

  insert into public.notification_queue (session_id, kind, payload)
  select
    s.id,
    'session_expired',
    jsonb_build_object('session_id', s.id, 'atv_id', s.atv_id, 'target_end_at', s.target_end_at)
  from public.sessions s
  where s.status = 'completed'
    and s.ended_at = greatest(s.target_end_at, s.started_at)
    and s.target_end_at <= v_now
  on conflict (session_id) do nothing;

  return v_count;
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

  if v_session.status = 'paused' then
    v_effective_end := coalesce(v_session.paused_at, v_now);
  else
    v_effective_end := v_now;
  end if;

  v_minutes_used := ceil(extract(epoch from (v_effective_end - v_session.started_at)) / 60.0)::integer;
  v_minutes_billed := public.calculate_billed_minutes(v_session.base_minutes, v_minutes_used);
  v_amount := public.calculate_amount_cop(v_session.base_minutes, v_session.base_price_cop, v_minutes_used);

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

create or replace function public.refresh_expired_brinca_sessions()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := timezone('utc', clock_timestamp());
  v_count integer := 0;
begin
  update public.brinca_sessions
  set
    status = 'completed',
    ended_at = greatest(target_end_at, started_at),
    paused_at = null,
    minutes_billed = public.calculate_billed_minutes(
      base_minutes,
      ceil(extract(epoch from (greatest(target_end_at, started_at) - started_at)) / 60.0)::integer
    ),
    amount_cop = public.calculate_amount_cop(
      base_minutes,
      base_price_cop,
      ceil(extract(epoch from (greatest(target_end_at, started_at) - started_at)) / 60.0)::integer
    ),
    updated_at = v_now
  where
    status = 'active'
    and target_end_at <= v_now;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function public.calculate_billed_minutes(integer, integer) to authenticated;
