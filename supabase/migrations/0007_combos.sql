-- Modulo Combos:
-- Relaciona una sesion de moto y una sesion de Brinca para un mismo nino.
-- Permite iniciar primero cualquiera de los dos servicios y cerrar el combo
-- automaticamente cuando ambas sesiones terminen.

create table if not exists public.combos (
  id uuid primary key default gen_random_uuid(),
  child_name text not null,
  start_mode text not null default 'either'
    check (start_mode in ('moto_first', 'brinca_first', 'either')),
  status text not null default 'pending'
    check (status in ('pending', 'in_progress', 'completed', 'cancelled')),
  atv_id uuid references public.atvs(id) on delete set null,
  moto_duration_minutes integer not null check (moto_duration_minutes > 0),
  brinca_duration_minutes integer not null check (brinca_duration_minutes > 0),
  moto_session_id uuid unique references public.sessions(id) on delete set null,
  brinca_session_id uuid unique references public.brinca_sessions(id) on delete set null,
  moto_completed_at timestamptz,
  brinca_completed_at timestamptz,
  completed_at timestamptz,
  started_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_combos_status_created_at
  on public.combos(status, created_at desc);

create index if not exists idx_combos_atv_id
  on public.combos(atv_id);

drop trigger if exists trg_combos_updated_at on public.combos;
create trigger trg_combos_updated_at
before update on public.combos
for each row
execute function public.set_updated_at();

create or replace function public.reconcile_combo_status(
  p_combo_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_combo public.combos%rowtype;
  v_now timestamptz := timezone('utc', clock_timestamp());
  v_completed_at timestamptz;
begin
  select * into v_combo
  from public.combos
  where id = p_combo_id;

  if not found then
    return;
  end if;

  if v_combo.status = 'cancelled' then
    return;
  end if;

  if v_combo.moto_completed_at is not null and v_combo.brinca_completed_at is not null then
    v_completed_at := greatest(v_combo.moto_completed_at, v_combo.brinca_completed_at);

    update public.combos
    set
      status = 'completed',
      completed_at = coalesce(v_combo.completed_at, v_completed_at),
      updated_at = v_now
    where id = v_combo.id;

    return;
  end if;

  if v_combo.moto_session_id is not null or v_combo.brinca_session_id is not null then
    update public.combos
    set
      status = 'in_progress',
      completed_at = null,
      updated_at = v_now
    where id = v_combo.id;

    return;
  end if;

  update public.combos
  set
    status = 'pending',
    completed_at = null,
    updated_at = v_now
  where id = v_combo.id;
end;
$$;

create or replace function public.create_combo(
  p_child_name text,
  p_start_mode text default 'either',
  p_moto_duration_minutes integer default 10,
  p_brinca_duration_minutes integer default 15,
  p_atv_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_combo_id uuid;
  v_child_name text;
  v_start_mode text;
  v_moto_duration integer;
  v_brinca_duration integer;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  v_child_name := trim(coalesce(p_child_name, ''));
  if length(v_child_name) = 0 then
    raise exception 'Debes ingresar el nombre del nino';
  end if;

  v_start_mode := lower(trim(coalesce(p_start_mode, 'either')));
  if v_start_mode not in ('moto_first', 'brinca_first', 'either') then
    raise exception 'Modo de inicio invalido';
  end if;

  v_moto_duration := greatest(1, coalesce(p_moto_duration_minutes, 10));
  v_brinca_duration := greatest(1, coalesce(p_brinca_duration_minutes, 15));

  if p_atv_id is not null then
    if not exists (
      select 1
      from public.atvs
      where id = p_atv_id
        and active = true
        and deleted_at is null
    ) then
      raise exception 'La cuatrimoto seleccionada no esta disponible';
    end if;
  end if;

  insert into public.combos (
    child_name,
    start_mode,
    status,
    atv_id,
    moto_duration_minutes,
    brinca_duration_minutes,
    started_by
  )
  values (
    v_child_name,
    v_start_mode,
    'pending',
    p_atv_id,
    v_moto_duration,
    v_brinca_duration,
    auth.uid()
  )
  returning id into v_combo_id;

  return v_combo_id;
end;
$$;

create or replace function public.start_combo_moto_leg(
  p_combo_id uuid,
  p_atv_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_combo public.combos%rowtype;
  v_atv_id uuid;
  v_session_id uuid;
  v_now timestamptz := timezone('utc', clock_timestamp());
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  select * into v_combo
  from public.combos
  where id = p_combo_id;

  if not found then
    raise exception 'Combo no encontrado';
  end if;

  if v_combo.status = 'cancelled' then
    raise exception 'El combo esta cancelado';
  end if;

  if v_combo.status = 'completed' then
    raise exception 'El combo ya esta completado';
  end if;

  if v_combo.start_mode = 'brinca_first' and v_combo.brinca_session_id is null then
    raise exception 'Este combo debe iniciar por Brinca';
  end if;

  if v_combo.moto_session_id is not null then
    return v_combo.moto_session_id;
  end if;

  v_atv_id := coalesce(p_atv_id, v_combo.atv_id);
  if v_atv_id is null then
    raise exception 'Debes seleccionar una cuatrimoto para este combo';
  end if;

  v_session_id := public.start_session(v_atv_id, v_combo.moto_duration_minutes);

  update public.combos
  set
    atv_id = v_atv_id,
    moto_session_id = v_session_id,
    status = 'in_progress',
    updated_at = v_now
  where id = v_combo.id;

  perform public.reconcile_combo_status(v_combo.id);
  return v_session_id;
end;
$$;

create or replace function public.start_combo_brinca_leg(
  p_combo_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_combo public.combos%rowtype;
  v_session_id uuid;
  v_now timestamptz := timezone('utc', clock_timestamp());
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  select * into v_combo
  from public.combos
  where id = p_combo_id;

  if not found then
    raise exception 'Combo no encontrado';
  end if;

  if v_combo.status = 'cancelled' then
    raise exception 'El combo esta cancelado';
  end if;

  if v_combo.status = 'completed' then
    raise exception 'El combo ya esta completado';
  end if;

  if v_combo.start_mode = 'moto_first' and v_combo.moto_session_id is null then
    raise exception 'Este combo debe iniciar por Moto';
  end if;

  if v_combo.brinca_session_id is not null then
    return v_combo.brinca_session_id;
  end if;

  v_session_id := public.start_brinca_session(v_combo.child_name, v_combo.brinca_duration_minutes);

  update public.combos
  set
    brinca_session_id = v_session_id,
    status = 'in_progress',
    updated_at = v_now
  where id = v_combo.id;

  perform public.reconcile_combo_status(v_combo.id);
  return v_session_id;
end;
$$;

create or replace function public.cancel_combo(
  p_combo_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_combo public.combos%rowtype;
  v_now timestamptz := timezone('utc', clock_timestamp());
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  select * into v_combo
  from public.combos
  where id = p_combo_id;

  if not found then
    raise exception 'Combo no encontrado';
  end if;

  if v_combo.status = 'completed' then
    raise exception 'No puedes cancelar un combo completado';
  end if;

  if exists (
    select 1
    from public.sessions s
    where s.id = v_combo.moto_session_id
      and s.status in ('active', 'paused')
  ) then
    raise exception 'Debes cerrar la sesion de moto antes de cancelar el combo';
  end if;

  if exists (
    select 1
    from public.brinca_sessions bs
    where bs.id = v_combo.brinca_session_id
      and bs.status in ('active', 'paused')
  ) then
    raise exception 'Debes cerrar la sesion de Brinca antes de cancelar el combo';
  end if;

  update public.combos
  set
    status = 'cancelled',
    completed_at = coalesce(completed_at, v_now),
    updated_at = v_now
  where id = v_combo.id;

  return v_combo.id;
end;
$$;

create or replace function public.sync_combo_from_moto_session()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := timezone('utc', clock_timestamp());
  v_combo_id uuid;
begin
  if new.status not in ('completed', 'cancelled') then
    return null;
  end if;

  if old.status in ('completed', 'cancelled') then
    return null;
  end if;

  update public.combos
  set
    moto_completed_at = coalesce(new.ended_at, v_now),
    updated_at = v_now
  where moto_session_id = new.id
  returning id into v_combo_id;

  if v_combo_id is not null then
    perform public.reconcile_combo_status(v_combo_id);
  end if;

  return null;
end;
$$;

drop trigger if exists trg_sync_combo_from_moto_session on public.sessions;
create trigger trg_sync_combo_from_moto_session
after update of status, ended_at on public.sessions
for each row
when (new.status in ('completed', 'cancelled'))
execute function public.sync_combo_from_moto_session();

create or replace function public.sync_combo_from_brinca_session()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := timezone('utc', clock_timestamp());
  v_combo_id uuid;
begin
  if new.status not in ('completed', 'cancelled') then
    return null;
  end if;

  if old.status in ('completed', 'cancelled') then
    return null;
  end if;

  update public.combos
  set
    brinca_completed_at = coalesce(new.ended_at, v_now),
    updated_at = v_now
  where brinca_session_id = new.id
  returning id into v_combo_id;

  if v_combo_id is not null then
    perform public.reconcile_combo_status(v_combo_id);
  end if;

  return null;
end;
$$;

drop trigger if exists trg_sync_combo_from_brinca_session on public.brinca_sessions;
create trigger trg_sync_combo_from_brinca_session
after update of status, ended_at on public.brinca_sessions
for each row
when (new.status in ('completed', 'cancelled'))
execute function public.sync_combo_from_brinca_session();

alter table public.combos enable row level security;

drop policy if exists "Combos select for authenticated" on public.combos;
create policy "Combos select for authenticated"
  on public.combos
  for select
  to authenticated
  using (true);

grant select on public.combos to authenticated;
grant execute on function public.reconcile_combo_status(uuid) to authenticated;
grant execute on function public.create_combo(text, text, integer, integer, uuid) to authenticated;
grant execute on function public.start_combo_moto_leg(uuid, uuid) to authenticated;
grant execute on function public.start_combo_brinca_leg(uuid) to authenticated;
grant execute on function public.cancel_combo(uuid) to authenticated;
