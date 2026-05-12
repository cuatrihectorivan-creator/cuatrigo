-- Modulo Brinca:
-- - Configuracion de tarifa base (por defecto 15 min = 5000 COP)
-- - Sesiones por nino con temporizador
-- - Cierre automatico de sesiones vencidas

create table if not exists public.brinca_settings (
  id boolean primary key default true check (id = true),
  base_minutes integer not null default 15 check (base_minutes > 0),
  base_price_cop integer not null default 5000 check (base_price_cop > 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

insert into public.brinca_settings (id, base_minutes, base_price_cop)
values (true, 15, 5000)
on conflict (id) do nothing;

create table if not exists public.brinca_sessions (
  id uuid primary key default gen_random_uuid(),
  child_name text not null,
  started_by uuid not null references auth.users(id) on delete restrict,
  started_at timestamptz not null default timezone('utc', now()),
  target_end_at timestamptz not null,
  paused_at timestamptz,
  ended_at timestamptz,
  status public.session_status not null default 'active',
  base_minutes integer not null check (base_minutes > 0),
  base_price_cop integer not null check (base_price_cop > 0),
  minutes_billed integer check (minutes_billed is null or minutes_billed >= 0),
  amount_cop integer check (amount_cop is null or amount_cop >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_brinca_sessions_status_end
  on public.brinca_sessions(status, target_end_at);

create index if not exists idx_brinca_sessions_closed_at
  on public.brinca_sessions(ended_at desc);

drop trigger if exists trg_brinca_settings_updated_at on public.brinca_settings;
create trigger trg_brinca_settings_updated_at
before update on public.brinca_settings
for each row
execute function public.set_updated_at();

drop trigger if exists trg_brinca_sessions_updated_at on public.brinca_sessions;
create trigger trg_brinca_sessions_updated_at
before update on public.brinca_sessions
for each row
execute function public.set_updated_at();

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

  if p_base_price_cop is null or p_base_price_cop <= 0 then
    raise exception 'Base precio debe ser mayor que cero';
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
  v_minutes integer;
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

  v_minutes := ceil(extract(epoch from (v_effective_end - v_session.started_at)) / 60.0)::integer;
  v_amount := public.calculate_amount_cop(v_session.base_minutes, v_session.base_price_cop, v_minutes);

  update public.brinca_sessions
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

create or replace function public.pause_brinca_session(
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

  if v_session.status = 'paused' then
    return v_session.id;
  end if;

  if v_session.status <> 'active' then
    raise exception 'Solo una sesion activa se puede pausar';
  end if;

  update public.brinca_sessions
  set
    status = 'paused',
    paused_at = v_now,
    updated_at = v_now
  where id = v_session.id;

  return v_session.id;
end;
$$;

create or replace function public.resume_brinca_session(
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
  v_pause_interval interval;
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

  if v_session.status = 'active' then
    return v_session.id;
  end if;

  if v_session.status <> 'paused' then
    raise exception 'Solo una sesion pausada se puede reanudar';
  end if;

  v_pause_interval := greatest(v_now - coalesce(v_session.paused_at, v_now), interval '0 seconds');

  update public.brinca_sessions
  set
    status = 'active',
    paused_at = null,
    target_end_at = target_end_at + v_pause_interval,
    updated_at = v_now
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

  if v_session.status not in ('active', 'paused') then
    raise exception 'Solo se puede extender una sesion abierta';
  end if;

  update public.brinca_sessions
  set target_end_at = target_end_at + make_interval(mins => p_extra_minutes)
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
    minutes_billed = ceil(extract(epoch from (greatest(target_end_at, started_at) - started_at)) / 60.0)::integer,
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

alter table public.brinca_settings enable row level security;
alter table public.brinca_sessions enable row level security;

drop policy if exists "Brinca settings select for authenticated" on public.brinca_settings;
create policy "Brinca settings select for authenticated"
  on public.brinca_settings
  for select
  to authenticated
  using (true);

drop policy if exists "Brinca settings admin write" on public.brinca_settings;
create policy "Brinca settings admin write"
  on public.brinca_settings
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "Brinca sessions select for authenticated" on public.brinca_sessions;
create policy "Brinca sessions select for authenticated"
  on public.brinca_sessions
  for select
  to authenticated
  using (true);

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if not exists (
      select 1
      from cron.job
      where jobname = 'cuatrigo-refresh-expired-brinca-sessions-every-minute'
    ) then
      perform cron.schedule(
        'cuatrigo-refresh-expired-brinca-sessions-every-minute',
        '* * * * *',
        $job$select public.refresh_expired_brinca_sessions();$job$
      );
    end if;
  end if;
exception
  when undefined_table then
    raise notice 'Catalogo de pg_cron no disponible; se omite programacion.';
end;
$$;

grant select on public.brinca_settings to authenticated;
grant select on public.brinca_sessions to authenticated;

grant execute on function public.update_brinca_settings(integer, integer) to authenticated;
grant execute on function public.start_brinca_session(text, integer) to authenticated;
grant execute on function public.stop_brinca_session(uuid) to authenticated;
grant execute on function public.pause_brinca_session(uuid) to authenticated;
grant execute on function public.resume_brinca_session(uuid) to authenticated;
grant execute on function public.extend_brinca_session(uuid, integer) to authenticated;
grant execute on function public.refresh_expired_brinca_sessions() to authenticated;
