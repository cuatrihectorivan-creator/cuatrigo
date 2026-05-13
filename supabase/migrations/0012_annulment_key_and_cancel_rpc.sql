-- Seguridad de anulacion (MVP robusto):
-- - Clave de anulacion guardada como hash en base de datos.
-- - Validacion obligatoria por RPC para anular sesiones Moto, Brinca y Combos.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.annulment_security (
  id boolean primary key default true check (id = true),
  key_hash text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists trg_annulment_security_updated_at on public.annulment_security;
create trigger trg_annulment_security_updated_at
before update on public.annulment_security
for each row
execute function public.set_updated_at();

create or replace function public.set_annulment_key(
  p_plain_key text
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_key text := trim(coalesce(p_plain_key, ''));
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Solo admin puede actualizar la clave de anulacion';
  end if;

  if length(v_key) < 4 then
    raise exception 'La clave de anulacion debe tener al menos 4 caracteres';
  end if;

  insert into public.annulment_security (id, key_hash)
  values (true, crypt(v_key, gen_salt('bf', 10)))
  on conflict (id) do update
  set
    key_hash = excluded.key_hash,
    updated_at = timezone('utc', clock_timestamp());

  return true;
end;
$$;

create or replace function public.assert_annulment_key(
  p_annul_key text
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_key text := trim(coalesce(p_annul_key, ''));
  v_hash text;
begin
  if length(v_key) = 0 then
    raise exception 'Debes ingresar la clave de anulacion';
  end if;

  select key_hash into v_hash
  from public.annulment_security
  where id = true;

  if v_hash is null then
    raise exception 'Clave de anulacion no configurada';
  end if;

  if v_hash <> crypt(v_key, v_hash) then
    raise exception 'Clave de anulacion invalida';
  end if;
end;
$$;

create or replace function public.cancel_session(
  p_session_id uuid,
  p_annul_key text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.sessions%rowtype;
  v_now timestamptz := timezone('utc', clock_timestamp());
  v_effective_end timestamptz;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  perform public.assert_annulment_key(p_annul_key);

  select * into v_session
  from public.sessions
  where id = p_session_id;

  if not found then
    raise exception 'Sesion no encontrada';
  end if;

  if v_session.status = 'cancelled' then
    return v_session.id;
  end if;

  if v_session.status = 'completed' then
    raise exception 'Solo puedes anular una sesion en curso';
  end if;

  if v_session.status = 'paused' then
    v_effective_end := coalesce(v_session.paused_at, v_now);
  else
    v_effective_end := v_now;
  end if;

  update public.sessions
  set
    status = 'cancelled',
    ended_at = v_effective_end,
    paused_at = null,
    minutes_billed = 0,
    amount_cop = 0,
    updated_at = v_now
  where id = v_session.id;

  return v_session.id;
end;
$$;

create or replace function public.cancel_brinca_session(
  p_session_id uuid,
  p_annul_key text
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
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  perform public.assert_annulment_key(p_annul_key);

  select * into v_session
  from public.brinca_sessions
  where id = p_session_id;

  if not found then
    raise exception 'Sesion de Brinca no encontrada';
  end if;

  if v_session.status = 'cancelled' then
    return v_session.id;
  end if;

  if v_session.status = 'completed' then
    raise exception 'Solo puedes anular una sesion de Brinca en curso';
  end if;

  if v_session.status = 'paused' then
    v_effective_end := coalesce(v_session.paused_at, v_now);
  else
    v_effective_end := v_now;
  end if;

  update public.brinca_sessions
  set
    status = 'cancelled',
    ended_at = v_effective_end,
    paused_at = null,
    minutes_billed = 0,
    amount_cop = 0,
    updated_at = v_now
  where id = v_session.id;

  return v_session.id;
end;
$$;

drop function if exists public.cancel_combo(uuid);
create or replace function public.cancel_combo(
  p_combo_id uuid,
  p_annul_key text
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

  perform public.assert_annulment_key(p_annul_key);

  select * into v_combo
  from public.combos
  where id = p_combo_id;

  if not found then
    raise exception 'Combo no encontrado';
  end if;

  if v_combo.status = 'cancelled' then
    return v_combo.id;
  end if;

  if v_combo.status = 'completed' then
    raise exception 'No puedes cancelar un combo completado';
  end if;

  if v_combo.moto_session_id is not null then
    update public.sessions
    set
      status = 'cancelled',
      ended_at = case
        when status = 'paused' then coalesce(paused_at, v_now)
        else v_now
      end,
      paused_at = null,
      minutes_billed = 0,
      amount_cop = 0,
      updated_at = v_now
    where id = v_combo.moto_session_id
      and status in ('active', 'paused');
  end if;

  if v_combo.brinca_session_id is not null then
    update public.brinca_sessions
    set
      status = 'cancelled',
      ended_at = case
        when status = 'paused' then coalesce(paused_at, v_now)
        else v_now
      end,
      paused_at = null,
      minutes_billed = 0,
      amount_cop = 0,
      updated_at = v_now
    where id = v_combo.brinca_session_id
      and status in ('active', 'paused');
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

-- Seed inicial solicitado por negocio (puede rotarse luego con set_annulment_key).
insert into public.annulment_security (id, key_hash)
select true, extensions.crypt('5784', extensions.gen_salt('bf', 10))
where not exists (
  select 1
  from public.annulment_security
  where id = true
);

grant execute on function public.set_annulment_key(text) to authenticated;
grant execute on function public.cancel_session(uuid, text) to authenticated;
grant execute on function public.cancel_brinca_session(uuid, text) to authenticated;
grant execute on function public.cancel_combo(uuid, text) to authenticated;
