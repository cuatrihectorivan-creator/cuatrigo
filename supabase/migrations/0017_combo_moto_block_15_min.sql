-- Regla comercial de combos (actualizada):
-- - Moto en combo: 15 min = 8000 COP (por bloques cerrados de 15)
-- - Brinca en combo: 15 min = 5000 COP (sin cambios)
-- Antes el bloque de Moto era de 10 min, por lo que una sesion de combo de
-- 15 min se cobraba como 2 bloques (16000 COP) en lugar de 1 (8000 COP).

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
    v_base_minutes := 15;
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
      case
        when exists (
          select 1
          from public.combos c
          where c.moto_session_id = public.sessions.id
            and c.status <> 'cancelled'
        ) then 15
        else atvs.base_minutes
      end,
      ceil(extract(epoch from (greatest(target_end_at, started_at) - started_at)) / 60.0)::integer
    ),
    amount_cop = public.calculate_amount_cop(
      case
        when exists (
          select 1
          from public.combos c
          where c.moto_session_id = public.sessions.id
            and c.status <> 'cancelled'
        ) then 15
        else atvs.base_minutes
      end,
      case
        when exists (
          select 1
          from public.combos c
          where c.moto_session_id = public.sessions.id
            and c.status <> 'cancelled'
        ) then 8000
        else atvs.base_price_cop
      end,
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
