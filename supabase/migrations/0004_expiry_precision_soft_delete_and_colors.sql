-- Mejoras de operacion:
-- 1) Cierre automatico de sesiones vencidas sin cobrar minutos extra.
-- 2) Eliminacion logica de cuatrimotos conservando historial financiero.
-- 3) Color configurable por cuatrimoto.

alter table public.atvs
  add column if not exists color_hex text,
  add column if not exists deleted_at timestamptz;

update public.atvs
set color_hex = coalesce(color_hex, '#3b82f6')
where color_hex is null;

alter table public.atvs
  alter column color_hex set default '#3b82f6';

alter table public.atvs
  drop constraint if exists atvs_plate_key;

create unique index if not exists idx_atvs_plate_unique_not_deleted
  on public.atvs (plate)
  where plate is not null and deleted_at is null;

create or replace function public.delete_atv(
  p_atv_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_atv public.atvs%rowtype;
  v_now timestamptz := timezone('utc', clock_timestamp());
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  if not public.is_admin() then
    raise exception 'Solo admin puede eliminar cuatrimotos';
  end if;

  select * into v_atv
  from public.atvs
  where id = p_atv_id and deleted_at is null;

  if not found then
    raise exception 'Cuatrimoto no encontrada';
  end if;

  if exists (
    select 1
    from public.sessions
    where atv_id = p_atv_id
      and status in ('active', 'paused')
  ) then
    raise exception 'No puedes eliminar una cuatrimoto con sesion abierta';
  end if;

  update public.atvs
  set
    active = false,
    deleted_at = v_now,
    updated_at = v_now
  where id = p_atv_id;

  return p_atv_id;
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
    minutes_billed = ceil(extract(epoch from (greatest(target_end_at, started_at) - started_at)) / 60.0)::integer,
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

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if not exists (
      select 1
      from cron.job
      where jobname = 'cuatrigo-refresh-expired-sessions-every-minute'
    ) then
      perform cron.schedule(
        'cuatrigo-refresh-expired-sessions-every-minute',
        '* * * * *',
        $job$select public.refresh_expired_sessions();$job$
      );
    end if;
  end if;
exception
  when undefined_table then
    raise notice 'Catalogo de pg_cron no disponible; se omite programacion.';
end;
$$;

grant execute on function public.delete_atv(uuid) to authenticated;
