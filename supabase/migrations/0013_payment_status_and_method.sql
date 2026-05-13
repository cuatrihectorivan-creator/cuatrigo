-- Medio/estado de pago por sesion (Moto + Brinca)
-- Reglas:
-- - Estado: pending | paid
-- - Metodo: cash | nequi
-- - Metodo solo aplica cuando estado = paid.

alter table public.sessions
  add column if not exists payment_status text,
  add column if not exists payment_method text;

alter table public.brinca_sessions
  add column if not exists payment_status text,
  add column if not exists payment_method text;

update public.sessions
set payment_status = 'pending'
where payment_status is null;

update public.sessions
set payment_method = null
where payment_method is not null
  and payment_method not in ('cash', 'nequi');

update public.brinca_sessions
set payment_status = 'pending'
where payment_status is null;

update public.brinca_sessions
set payment_method = null
where payment_method is not null
  and payment_method not in ('cash', 'nequi');

alter table public.sessions
  alter column payment_status set default 'pending',
  alter column payment_status set not null;

alter table public.brinca_sessions
  alter column payment_status set default 'pending',
  alter column payment_status set not null;

alter table public.sessions
  drop constraint if exists sessions_payment_status_check;
alter table public.sessions
  add constraint sessions_payment_status_check
  check (payment_status in ('pending', 'paid'));

alter table public.sessions
  drop constraint if exists sessions_payment_method_check;
alter table public.sessions
  add constraint sessions_payment_method_check
  check (payment_method is null or payment_method in ('cash', 'nequi'));

alter table public.brinca_sessions
  drop constraint if exists brinca_sessions_payment_status_check;
alter table public.brinca_sessions
  add constraint brinca_sessions_payment_status_check
  check (payment_status in ('pending', 'paid'));

alter table public.brinca_sessions
  drop constraint if exists brinca_sessions_payment_method_check;
alter table public.brinca_sessions
  add constraint brinca_sessions_payment_method_check
  check (payment_method is null or payment_method in ('cash', 'nequi'));

create or replace function public.set_session_payment(
  p_session_id uuid,
  p_payment_status text,
  p_payment_method text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.sessions%rowtype;
  v_status text := lower(trim(coalesce(p_payment_status, '')));
  v_method text := lower(trim(coalesce(p_payment_method, '')));
  v_now timestamptz := timezone('utc', clock_timestamp());
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  if v_status not in ('pending', 'paid') then
    raise exception 'Estado de pago invalido';
  end if;

  if v_status = 'paid' and v_method not in ('cash', 'nequi') then
    raise exception 'Metodo de pago invalido. Usa Efectivo o Nequi';
  end if;

  if v_status = 'pending' then
    v_method := '';
  end if;

  select * into v_session
  from public.sessions
  where id = p_session_id;

  if not found then
    raise exception 'Sesion no encontrada';
  end if;

  if v_session.status = 'cancelled' then
    raise exception 'No puedes marcar pago en una sesion anulada';
  end if;

  if v_session.status not in ('active', 'paused', 'completed') then
    raise exception 'La sesion no permite actualizar pago';
  end if;

  update public.sessions
  set
    payment_status = v_status,
    payment_method = case when v_status = 'paid' then v_method else null end,
    updated_at = v_now
  where id = v_session.id;

  return v_session.id;
end;
$$;

create or replace function public.set_brinca_payment(
  p_session_id uuid,
  p_payment_status text,
  p_payment_method text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.brinca_sessions%rowtype;
  v_status text := lower(trim(coalesce(p_payment_status, '')));
  v_method text := lower(trim(coalesce(p_payment_method, '')));
  v_now timestamptz := timezone('utc', clock_timestamp());
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  if v_status not in ('pending', 'paid') then
    raise exception 'Estado de pago invalido';
  end if;

  if v_status = 'paid' and v_method not in ('cash', 'nequi') then
    raise exception 'Metodo de pago invalido. Usa Efectivo o Nequi';
  end if;

  if v_status = 'pending' then
    v_method := '';
  end if;

  select * into v_session
  from public.brinca_sessions
  where id = p_session_id;

  if not found then
    raise exception 'Sesion de Brinca no encontrada';
  end if;

  if v_session.status = 'cancelled' then
    raise exception 'No puedes marcar pago en una sesion anulada';
  end if;

  if v_session.status not in ('active', 'paused', 'completed') then
    raise exception 'La sesion no permite actualizar pago';
  end if;

  update public.brinca_sessions
  set
    payment_status = v_status,
    payment_method = case when v_status = 'paid' then v_method else null end,
    updated_at = v_now
  where id = v_session.id;

  return v_session.id;
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
    payment_status = 'pending',
    payment_method = null,
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
    payment_status = 'pending',
    payment_method = null,
    minutes_billed = 0,
    amount_cop = 0,
    updated_at = v_now
  where id = v_session.id;

  return v_session.id;
end;
$$;

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
      payment_status = 'pending',
      payment_method = null,
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
      payment_status = 'pending',
      payment_method = null,
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

grant execute on function public.set_session_payment(uuid, text, text) to authenticated;
grant execute on function public.set_brinca_payment(uuid, text, text) to authenticated;
