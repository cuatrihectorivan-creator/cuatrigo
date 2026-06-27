-- Evita sesiones Brinca duplicadas por doble toque, reintentos de red o reenvio del formulario.

alter table public.brinca_sessions
  add column if not exists start_request_id uuid;

create unique index if not exists idx_brinca_sessions_start_request_id
  on public.brinca_sessions(start_request_id);

drop function if exists public.start_brinca_session(text, integer);

create or replace function public.start_brinca_session(
  p_child_name text,
  p_duration_minutes integer default null,
  p_request_id uuid default null
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

  if p_request_id is not null then
    select id into v_session_id
    from public.brinca_sessions
    where start_request_id = p_request_id;

    if found then
      return v_session_id;
    end if;
  end if;

  select * into v_settings
  from public.brinca_settings
  where id = true;

  if not found then
    raise exception 'Configuracion de Brinca no encontrada';
  end if;

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
    base_price_cop,
    start_request_id
  )
  values (
    v_child_name,
    auth.uid(),
    v_now,
    v_now + make_interval(mins => v_duration),
    null,
    'active',
    v_settings.base_minutes,
    v_settings.base_price_cop,
    p_request_id
  )
  on conflict (start_request_id) do nothing
  returning id into v_session_id;

  if v_session_id is null and p_request_id is not null then
    select id into v_session_id
    from public.brinca_sessions
    where start_request_id = p_request_id;
  end if;

  if v_session_id is null then
    raise exception 'No se pudo iniciar la sesion de Brinca';
  end if;

  return v_session_id;
end;
$$;

grant execute on function public.start_brinca_session(text, integer, uuid) to authenticated;
